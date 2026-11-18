#+build linux, windows
package lava_runtime

import "core:c"
import "core:net"
import "core:strings"
import "core:sync"

// Minimal OpenSSL client bindings for the fetch HTTPS transport on Linux and
// Windows. We link libssl/libcrypto and bind only the handful of client-side
// symbols the non-blocking handshake/read/write needs. TLS records replace raw
// socket bytes in fetch_transport.odin; everything else (HTTP framing, the event
// loop) is shared with the plaintext path.
//
// Non-blocking model: the socket is the same non-blocking fd the plaintext path
// uses. SSL_connect/SSL_read/SSL_write return <= 0 with SSL_get_error reporting
// WANT_READ / WANT_WRITE; the caller re-arms the loop watcher for that direction
// and resumes when the fd is ready again.

// libssl provides the SSL_*/SSL_CTX_* symbols; libcrypto provides the X509
// verification-parameter helpers (e.g. X509_VERIFY_PARAM_set1_ip_asc). Both must
// be on the link line, so import them as a group. The library names differ by
// platform: the Unix linker's `system:` -l convention on Linux (same as
// sqlite3/javascriptcoregtk), and the import-lib filenames on Windows (as built
// by vcpkg / the OpenSSL installer). Both use the `system:` prefix so the names
// resolve via the linker's library search path — the build (CI Windows job) is
// responsible for putting the OpenSSL lib dir on that path.
when ODIN_OS == .Windows {
	// `system:` makes Odin search these via the linker's LIB path (like JSC's
	// import in pkg/jsc/bindings_windows.odin); a bare "libssl.lib" would instead
	// be resolved relative to this source file and fail to link.
	foreign import openssl_lib {"system:libssl.lib", "system:libcrypto.lib"}
} else {
	foreign import openssl_lib {"system:ssl", "system:crypto"}
}

SSL_CTX :: distinct rawptr
SSL :: distinct rawptr
SSL_METHOD :: distinct rawptr
X509_VERIFY_PARAM :: distinct rawptr
X509 :: distinct rawptr
X509_STORE :: distinct rawptr
// Server-side (https.createServer, tls_server.odin): memory BIOs decouple SSL from the
// fd so SSL_read/SSL_write run on completion-mode buffers, and EVP_PKEY/X509 carry the
// PEM-loaded key+cert. Declared here (with the other OpenSSL types) so the foreign block
// below names them; the server LOGIC that uses them is Linux-only (tls_server.odin).
BIO :: distinct rawptr
BIO_METHOD :: distinct rawptr
EVP_PKEY :: distinct rawptr
// pem_password_cb(buf, size, rwflag, userdata) -> length. tls_server.odin passes a no-op that
// returns 0 so an encrypted key fails to load rather than blocking on a terminal prompt.
PEM_password_cb :: #type proc "c" (buf: rawptr, size: c.int, rwflag: c.int, userdata: rawptr) -> c.int

// SSL_get_error result codes (openssl/ssl.h) that the transport acts on.
SSL_ERROR_WANT_READ :: 2
SSL_ERROR_WANT_WRITE :: 3
SSL_ERROR_SYSCALL :: 5
SSL_ERROR_ZERO_RETURN :: 6

SSL_VERIFY_PEER :: 0x01

// Values for the SSL_ctrl / SSL_CTX_ctrl macros we bind directly.
SSL_CTRL_SET_TLSEXT_HOSTNAME :: 55
SSL_CTRL_SET_MIN_PROTO_VERSION :: 123
TLSEXT_NAMETYPE_host_name :: 0
TLS1_2_VERSION :: 0x0303

// --- TLS server (tls_server.odin / https.createServer) ----------------------
// _set_mode / _set_session_cache_mode / add_extra_chain_cert are header MACROS over SSL_CTX_ctrl
// and STILL dispatch through it (verified against OpenSSL 3.5.5), so we invoke the ctrl with these
// command numbers (stable across 1.1.x / 3.x). NOTE: SSL_CTX_set_options is the EXCEPTION — it
// became a real exported function in OpenSSL 1.1.0 and SSL_CTRL_OPTIONS (32) is no longer dispatched
// by SSL_CTX_ctrl (a ctrl call silently returns 0 and sets nothing), so it is bound as a function
// below, NOT invoked via ctrl.
SSL_CTRL_MODE :: 33
SSL_CTRL_SET_SESS_CACHE_MODE :: 44
SSL_CTRL_EXTRA_CHAIN_CERT :: 14
// Hardening bits (openssl/ssl.h). min-proto TLS 1.2 already disables SSLv3/TLS1.0/1.1, so
// the only options we set are: refuse peer renegotiation (a DoS vector; gone in TLS 1.3)
// and suppress TLS 1.2 session tickets (resumption is deferred — see also num_tickets(0)).
SSL_OP_NO_RENEGOTIATION :: 0x40000000
SSL_OP_NO_TICKET :: 0x00004000
// Free each SSL's ~16 KiB read/write buffers between records so many idle keep-alive TLS
// conns stay cheap (the http server's memory moat); SSL_SESS_CACHE_OFF keeps "no resumption"
// honest and bounds the server session cache.
SSL_MODE_RELEASE_BUFFERS :: 0x00000010
SSL_SESS_CACHE_OFF :: 0x0

@(default_calling_convention = "c")
foreign openssl_lib {
	TLS_client_method :: proc() -> SSL_METHOD ---
	SSL_CTX_new :: proc(method: SSL_METHOD) -> SSL_CTX ---
	SSL_CTX_free :: proc(ctx: SSL_CTX) ---
	SSL_CTX_set_default_verify_paths :: proc(ctx: SSL_CTX) -> c.int ---
	SSL_CTX_set_verify :: proc(ctx: SSL_CTX, mode: c.int, callback: rawptr) ---
	SSL_CTX_ctrl :: proc(ctx: SSL_CTX, cmd: c.int, larg: c.long, parg: rawptr) -> c.long ---

	SSL_new :: proc(ctx: SSL_CTX) -> SSL ---
	SSL_free :: proc(ssl: SSL) ---
	SSL_set_fd :: proc(ssl: SSL, fd: c.int) -> c.int ---
	SSL_set1_host :: proc(ssl: SSL, hostname: cstring) -> c.int ---
	SSL_get0_param :: proc(ssl: SSL) -> X509_VERIFY_PARAM ---
	X509_VERIFY_PARAM_set1_ip_asc :: proc(param: X509_VERIFY_PARAM, ipasc: cstring) -> c.int ---
	SSL_ctrl :: proc(ssl: SSL, cmd: c.int, larg: c.long, parg: rawptr) -> c.long ---
	SSL_connect :: proc(ssl: SSL) -> c.int ---
	SSL_read :: proc(ssl: SSL, buf: rawptr, num: c.int) -> c.int ---
	SSL_write :: proc(ssl: SSL, buf: rawptr, num: c.int) -> c.int ---
	SSL_get_error :: proc(ssl: SSL, ret: c.int) -> c.int ---

	// X509 store access, used by the platform root-loading hook
	// (tls_load_platform_roots) to inject CA certificates the OpenSSL default
	// verify paths don't cover — notably the native Windows certificate store.
	SSL_CTX_get_cert_store :: proc(ctx: SSL_CTX) -> X509_STORE ---
	X509_STORE_add_cert :: proc(store: X509_STORE, x: X509) -> c.int ---
	d2i_X509 :: proc(px: ^X509, in_: ^[^]byte, len: c.long) -> X509 ---
	X509_free :: proc(x: X509) ---

	// --- TLS server (tls_server.odin). Symbols are declared on every platform tls.odin
	// builds for (linux, windows); only the Linux server logic references them, so an
	// unreferenced build (Windows) needs no link dependency on them. ---
	TLS_server_method :: proc() -> SSL_METHOD ---
	SSL_set_accept_state :: proc(ssl: SSL) ---
	SSL_accept :: proc(ssl: SSL) -> c.int ---
	SSL_shutdown :: proc(ssl: SSL) -> c.int ---
	SSL_CTX_set_num_tickets :: proc(ctx: SSL_CTX, num_tickets: c.size_t) -> c.int ---
	// Real function since OpenSSL 1.1.0 (NOT a ctrl macro — see the SSL_CTRL note above). On 64-bit
	// the ABI is identical for OpenSSL 1.1.1's `unsigned long` and 3.x's `uint64_t`, and net is
	// Linux/64-bit only, so binding the wider uint64 is safe for both.
	SSL_CTX_set_options :: proc(ctx: SSL_CTX, op: c.uint64_t) -> c.uint64_t ---
	// Memory BIOs: BIO ownership transfers to the SSL via set0_* and is freed by SSL_free.
	SSL_set0_rbio :: proc(ssl: SSL, rbio: BIO) ---
	SSL_set0_wbio :: proc(ssl: SSL, wbio: BIO) ---
	BIO_new :: proc(type: BIO_METHOD) -> BIO ---
	BIO_s_mem :: proc() -> BIO_METHOD ---
	BIO_new_mem_buf :: proc(buf: rawptr, len: c.int) -> BIO ---
	BIO_free :: proc(b: BIO) -> c.int ---
	BIO_read :: proc(b: BIO, data: rawptr, dlen: c.int) -> c.int ---
	BIO_write :: proc(b: BIO, data: rawptr, dlen: c.int) -> c.int ---
	// PEM load from memory (Node passes PEM CONTENT, not paths) + install into the context.
	// The cb (pem_password_cb) is a no-op in tls_server.odin so an encrypted key fails
	// closed instead of blocking on a terminal prompt (the default cb reads the console).
	PEM_read_bio_X509 :: proc(bp: BIO, x: ^X509, cb: PEM_password_cb, u: rawptr) -> X509 ---
	PEM_read_bio_PrivateKey :: proc(bp: BIO, x: ^EVP_PKEY, cb: PEM_password_cb, u: rawptr) -> EVP_PKEY ---
	EVP_PKEY_free :: proc(pkey: EVP_PKEY) ---
	SSL_CTX_use_certificate :: proc(ctx: SSL_CTX, x: X509) -> c.int ---
	SSL_CTX_use_PrivateKey :: proc(ctx: SSL_CTX, pkey: EVP_PKEY) -> c.int ---
	SSL_CTX_check_private_key :: proc(ctx: SSL_CTX) -> c.int ---
	// Clear the thread's error queue (PEM end-of-stream leaves a benign error there).
	ERR_clear_error :: proc() ---
}

// g_tls_ctx is a process-wide client context, created lazily on the first
// https:// fetch. SSL_CTX is reference-counted and safe to share across the
// SSL_new of every request; OpenSSL 1.1+ self-initialises on first use, so no
// explicit library init call is needed. It is never freed — it lives for the
// process, like g_fetch_cancel_class.
@(private = "file")
g_tls_ctx: SSL_CTX
// g_tls_ctx_once makes the lazy build race-safe when N workers' (Slice 3a) first https fetches
// collide. The built SSL_CTX is refcounted and safe to share across workers; a failed build leaves
// g_tls_ctx nil and is not retried (TLS_client_method / verify-paths failures are deterministic, not
// transient), which matches the prior behaviour's effective outcome.
@(private = "file")
g_tls_ctx_once: sync.Once

@(private = "file")
tls_build_ctx :: proc() {
	method := TLS_client_method()
	if method == nil do return
	ctx := SSL_CTX_new(method)
	if ctx == nil do return
	// Fail closed if the trust store can't be loaded (verification would have
	// nothing to check against) or the TLS 1.2 floor can't be set. Both return
	// 1 on success; SSL_CTX_ctrl(SET_MIN_PROTO_VERSION) returns 1 likewise.
	if SSL_CTX_set_default_verify_paths(ctx) != 1 ||
	   SSL_CTX_ctrl(ctx, SSL_CTRL_SET_MIN_PROTO_VERSION, TLS1_2_VERSION, nil) != 1 {
		SSL_CTX_free(ctx)
		return
	}
	// Add any platform-native roots (Windows cert store) on top of the OpenSSL
	// defaults. Best-effort: if it loads nothing, verification simply falls back
	// to whatever set_default_verify_paths / SSL_CERT_FILE provided and a missing
	// root fails the handshake closed — it never weakens verification.
	tls_load_platform_roots(ctx)
	SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, nil)
	g_tls_ctx = ctx
}

// tls_client_ctx returns the shared client SSL_CTX, building it on first use:
// system trust store for verification, peer verification on (so a bad cert
// fails the handshake), and a TLS 1.2 floor. Returns nil if the context could
// not be created. set_default_verify_paths honours the SSL_CERT_FILE /
// SSL_CERT_DIR environment variables, which the HTTPS smoke test uses to trust
// its self-signed CA.
//
// TRUST STORE: set_default_verify_paths reads OpenSSL's compiled-in default cert
// locations, which find the system roots on Linux but NOT the native Windows
// certificate store (OpenSSL has no Windows-store backend). So we then call the
// platform root hook (tls_load_platform_roots): a no-op on Linux, and on Windows
// it loads the machine ROOT/CA stores into this context's
// X509_STORE so a plain `fetch("https://...")` verifies against the OS roots.
// SSL_CERT_FILE still works everywhere as an explicit override (both sources feed
// the same store).
tls_client_ctx :: proc() -> SSL_CTX {
	sync.once_do(&g_tls_ctx_once, tls_build_ctx)
	return g_tls_ctx
}

// tls_new_client builds a per-request SSL bound to the connected socket `fd`,
// with SNI and certificate hostname verification set to `host`. Returns nil on
// any setup failure. The returned SSL must be freed with SSL_free (see
// fetch_tls_cleanup).
tls_new_client :: proc(fd: uintptr, host: string) -> SSL {
	ctx := tls_client_ctx()
	if ctx == nil do return nil
	ssl := SSL_new(ctx)
	if ssl == nil do return nil
	// SSL_set_fd takes an int. On Windows req.fd is a SOCKET (a uintptr-wide
	// kernel handle); narrowing to c.int is the documented OpenSSL-on-Windows
	// convention (its BIO socket layer uses int) and real socket values fit.
	if SSL_set_fd(ssl, c.int(fd)) != 1 {
		SSL_free(ssl)
		return nil
	}
	// Verification needs a NUL-terminated host. OpenSSL copies it into its own
	// storage, so a temp-allocator cstring scoped to this proc is sufficient.
	chost, clone_err := strings.clone_to_cstring(host, context.temp_allocator)
	if clone_err != nil {
		SSL_free(ssl)
		return nil
	}
	// An IP-literal host verifies against the certificate's iPAddress SAN (not a
	// DNS name) and must NOT be sent as SNI (RFC 6066 forbids IP literals there).
	// A DNS name uses SNI + DNS-name verification. Fail closed: if any of these
	// setup calls fails we must not proceed with weaker (or no) verification.
	if tls_host_is_ip(host) {
		if X509_VERIFY_PARAM_set1_ip_asc(SSL_get0_param(ssl), chost) != 1 {
			SSL_free(ssl)
			return nil
		}
	} else {
		// SSL_ctrl returns 1 on a successful SET_TLSEXT_HOSTNAME.
		if SSL_ctrl(ssl, SSL_CTRL_SET_TLSEXT_HOSTNAME, TLSEXT_NAMETYPE_host_name, rawptr(chost)) != 1 {
			SSL_free(ssl)
			return nil
		}
		if SSL_set1_host(ssl, chost) != 1 {
			SSL_free(ssl)
			return nil
		}
	}
	return ssl
}

// tls_host_is_ip reports whether host is an IPv4 or IPv6 literal (so it should
// be verified as an IP address rather than a DNS name). The transport delivers
// IPv6 literals bracket-stripped (e.g. "::1"), matching net.parse_ip6_address.
tls_host_is_ip :: proc(host: string) -> bool {
	if _, ok := net.parse_ip4_address(host); ok do return true
	if _, ok := net.parse_ip6_address(host); ok do return true
	return false
}
