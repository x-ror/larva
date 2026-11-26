#+build linux, windows
package lava_tls

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

// SSL_get_error result codes (openssl/ssl.h) that the transport acts on.
SSL_ERROR_SSL :: 1
SSL_ERROR_WANT_READ :: 2
SSL_ERROR_WANT_WRITE :: 3
SSL_ERROR_SYSCALL :: 5
SSL_ERROR_ZERO_RETURN :: 6

// openssl/err.h, openssl/sslerr.h: the reason of a queued error, and the one OpenSSL 3
// reports when the peer closes TCP without a TLS close_notify.
ERR_SYSTEM_FLAG :: c.ulong(max(c.int)) + 1
ERR_REASON_MASK :: 0x7FFFFF
SSL_R_UNEXPECTED_EOF_WHILE_READING :: 294

// err_get_reason is OpenSSL's ERR_GET_REASON, an inline function in the header.
err_get_reason :: proc(e: c.ulong) -> c.int {
	if e & ERR_SYSTEM_FLAG != 0 {
		return c.int(e & ~ERR_SYSTEM_FLAG)
	}

	return c.int(e & ERR_REASON_MASK)
}

SSL_VERIFY_PEER :: 0x01

// Values for the SSL_ctrl / SSL_CTX_ctrl macros we bind directly.
SSL_CTRL_SET_TLSEXT_HOSTNAME :: 55
SSL_CTRL_SET_MIN_PROTO_VERSION :: 123
TLSEXT_NAMETYPE_host_name :: 0
TLS1_2_VERSION :: 0x0303

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

	// The thread's error queue: cleared before an SSL call, peeked to classify a failure.
	ERR_clear_error :: proc() ---
	ERR_peek_error :: proc() -> c.ulong ---
}

// g_tls_ctx is a process-wide client context, created lazily on the first
// https:// fetch. SSL_CTX is reference-counted and safe to share across the
// SSL_new of every request; OpenSSL 1.1+ self-initialises on first use, so no
// explicit library init call is needed. It is never freed — it lives for the
// process, like g_fetch_cancel_class.
@(private = "file")
g_tls_ctx: SSL_CTX
// g_tls_ctx_once makes the lazy build race-safe when several threads' (page dispatcher
// workers') first https fetches collide. The built SSL_CTX is refcounted and safe to share
// across threads; a failed build leaves g_tls_ctx nil and is not retried (TLS_client_method /
// verify-paths failures are deterministic, not transient), which matches the prior behaviour's
// effective outcome.
@(private = "file")
g_tls_ctx_once: sync.Once

@(private = "file")
tls_build_ctx :: proc() {
	method := TLS_client_method()

	if method == nil {
		return
	}

	ctx := SSL_CTX_new(method)

	if ctx == nil {
		return
	}

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

	if ctx == nil {
		return nil
	}

	ssl := SSL_new(ctx)

	if ssl == nil {
		return nil
	}

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
	if _, ok := net.parse_ip4_address(host); ok {
		return true
	}

	if _, ok := net.parse_ip6_address(host); ok {
		return true
	}

	return false
}
