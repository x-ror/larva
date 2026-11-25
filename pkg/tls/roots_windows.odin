#+build windows
package lava_tls

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

// The CryptoAPI cert-store calls and CERT_CONTEXT come from core:sys/windows
// (crypt32.odin): CertOpenSystemStoreW takes an unused legacy provider handle
// (pass nil) and the store name ("ROOT", "CA", ...); CertEnumCertificatesInStore
// returns the next cert and frees the one passed in, and nil ends the walk.

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
	hstore := win.CertOpenSystemStoreW(nil, name)

	if hstore == nil {
		return
	}

	defer win.CertCloseStore(hstore, 0)

	cert: ^win.CERT_CONTEXT
	for {
		cert = win.CertEnumCertificatesInStore(hstore, cert)

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
