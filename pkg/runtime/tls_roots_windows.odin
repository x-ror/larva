#+build windows
package lava_runtime

import "core:c"
import win "core:sys/windows"

// Platform TLS root policy for Windows. OpenSSL has no native Windows
// certificate-store backend, so SSL_CTX_set_default_verify_paths alone leaves a
// plain `fetch("https://...")` unable to verify against the machine's roots. This
// hook bridges the gap: it reads the Windows system "ROOT" (trusted roots) and
// "CA" (intermediate) stores via CryptoAPI and adds each DER certificate to the
// OpenSSL context's X509_STORE. It runs once, when the shared SSL_CTX is built
// (tls_client_ctx). Best-effort and additive — it never removes or weakens
// verification; certs already provided via SSL_CERT_FILE remain in force.

// Minimal CryptoAPI cert-store bindings (core:sys/windows has none). Layout per
// <wincrypt.h>: only the fields we read are typed precisely.
@(private = "file")
HCERTSTORE :: distinct rawptr

@(private = "file")
CERT_CONTEXT :: struct {
	dwCertEncodingType: win.DWORD,
	pbCertEncoded:      [^]byte, // DER-encoded certificate
	cbCertEncoded:      win.DWORD, // its length in bytes
	pCertInfo:          rawptr,
	hCertStore:         HCERTSTORE,
}

@(private = "file")
PCCERT_CONTEXT :: ^CERT_CONTEXT

foreign import crypt32 "system:Crypt32.lib"

@(default_calling_convention = "system")
foreign crypt32 {
	// hProv is an unused legacy handle (pass nil); szSubsystemProtocol names the
	// system store ("ROOT", "CA", ...).
	CertOpenSystemStoreW :: proc(hProv: rawptr, szSubsystemProtocol: win.wstring) -> HCERTSTORE ---
	// Returns the next cert in the store, freeing the one passed in; nil ends the
	// walk (the final context is freed for us). Pass nil to start.
	CertEnumCertificatesInStore :: proc(hCertStore: HCERTSTORE, pPrevCertContext: PCCERT_CONTEXT) -> PCCERT_CONTEXT ---
	CertCloseStore :: proc(hCertStore: HCERTSTORE, dwFlags: win.DWORD) -> win.BOOL ---
}

tls_load_platform_roots :: proc(ctx: SSL_CTX) {
	store := SSL_CTX_get_cert_store(ctx)

	if store == nil {
		return
	}

	load_windows_store(store, win.utf8_to_wstring("ROOT"))
	load_windows_store(store, win.utf8_to_wstring("CA"))
}

// load_windows_store copies every certificate from a named Windows system store
// into the OpenSSL X509_STORE. Failures (store can't open, a cert won't parse, a
// duplicate add) are skipped, not fatal.
@(private = "file")
load_windows_store :: proc(store: X509_STORE, name: win.wstring) {
	hstore := CertOpenSystemStoreW(nil, name)

	if hstore == nil {
		return
	}

	defer CertCloseStore(hstore, 0)

	cert: PCCERT_CONTEXT
	for {
		cert = CertEnumCertificatesInStore(hstore, cert)

		if cert == nil {
			break
		}

		// d2i_X509 advances the pointer it's given, so hand it a local copy.
		der := cert.pbCertEncoded
		x := d2i_X509(nil, &der, c.long(cert.cbCertEncoded))

		if x == nil {continue} 	// not a DER X.509 cert we understand

		// add_cert up-refs on success and returns 0 for a duplicate (already in the
		// store) — both are fine. Either way we drop our own reference.
		X509_STORE_add_cert(store, x)
		X509_free(x)
	}
}
