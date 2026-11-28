#+build linux, windows
package lava_tls

import "base:runtime"
import "core:c"
import "core:net"
import "core:strings"
import "core:sync"
import profile "lava:pkg/profile"

// BoringSSL client bindings for the HTTPS transports on Linux and Windows: pkg/http's
// (lava fetch, page navigation) and the runtime's JS fetch (pkg/runtime/fetch_tls.odin).
// We bind only the client-side symbols the non-blocking handshake/read/write needs, plus
// the ClientHello knobs a client profile sets (#6, #8).
//
// Why BoringSSL (#6): sites behind Cloudflare/Akamai fingerprint the ClientHello
// (JA3/JA4), and OpenSSL cannot produce Chrome's — no GREASE, no extension permutation,
// no brotli certificate compression, no ALPS, no trust-anchor IDs. BoringSSL is what
// Chrome itself links. It is built from a pinned commit as static archives by
// scripts/build-boringssl.sh into .deps/boringssl (§2 step 5: see NOTICE and
// agents/prompts/odin-feature-reference/sdk-watch.json). Static, never next to a system
// libssl: both define every SSL_* symbol.
//
// Non-blocking model: the socket is the same non-blocking fd the plaintext path uses.
// SSL_connect/SSL_read/SSL_write return <= 0 with SSL_get_error reporting WANT_READ /
// WANT_WRITE; the caller re-arms the loop watcher for that direction and resumes when
// the fd is ready again.

// libssl before libcrypto: a static link resolves left to right. `foreign import`
// takes only literals, hence the relative paths (as pkg/html does for lexbor).
when ODIN_OS == .Windows {
	// Windows is not built in CI (Linux-first); scripts/build-windows.ps1 does not yet
	// build BoringSSL, so a Windows link fails loudly on the missing archive rather than
	// picking up some other OpenSSL.
	foreign import boringssl {"../../.deps/boringssl/lib/ssl.lib", "../../.deps/boringssl/lib/crypto.lib"}
} else {
	// libssl is C++: libstdc++ comes along, which costs nothing at run time — JSC
	// already loads it into every Larva process.
	foreign import boringssl {
		"../../.deps/boringssl/lib/libssl.a",
		"../../.deps/boringssl/lib/libcrypto.a",
		"system:stdc++",
	}
}

SSL_CTX :: distinct rawptr
SSL :: distinct rawptr
SSL_METHOD :: distinct rawptr
SSL_SESSION :: distinct rawptr
X509_VERIFY_PARAM :: distinct rawptr
X509 :: distinct rawptr
X509_STORE :: distinct rawptr
CRYPTO_BUFFER :: distinct rawptr

// SSL_get_error result codes (openssl/ssl.h) that the transports act on. BoringSSL
// reports a TCP close without close_notify as SSL_ERROR_SYSCALL with a zero return,
// never as an SSL_ERROR_SSL reason (OpenSSL 3's SSL_R_UNEXPECTED_EOF_WHILE_READING).
SSL_ERROR_SSL :: 1
SSL_ERROR_WANT_READ :: 2
SSL_ERROR_WANT_WRITE :: 3
SSL_ERROR_SYSCALL :: 5
SSL_ERROR_ZERO_RETURN :: 6

SSL_VERIFY_PEER :: 0x01
SSL_SESS_CACHE_CLIENT :: 0x0001
TLSEXT_NAMETYPE_host_name :: 0
TLS1_2_VERSION :: 0x0303
// RFC 8879 CertificateCompressionAlgorithm.
TLSEXT_cert_compression_brotli :: 2

// ssl_cert_decompression_func_t (openssl/ssl.h).
Cert_Decompress_Proc :: #type proc "c" (
	ssl: SSL,
	out: ^CRYPTO_BUFFER,
	uncompressed_len: c.size_t,
	input: [^]u8,
	in_len: c.size_t,
) -> c.int

// SSL_CTX_sess_set_new_cb's callback: 1 takes ownership of `session`.
New_Session_Proc :: #type proc "c" (ssl: SSL, session: SSL_SESSION) -> c.int

// Every binding below returns int/void/pointer: BoringSSL has no `_Bool` return among
// them (§4 FFI ABI), so none is declared `-> bool`.
@(default_calling_convention = "c")
foreign boringssl {
	TLS_method :: proc() -> SSL_METHOD ---
	SSL_CTX_new :: proc(method: SSL_METHOD) -> SSL_CTX ---
	SSL_CTX_free :: proc(ctx: SSL_CTX) ---
	SSL_CTX_set_default_verify_paths :: proc(ctx: SSL_CTX) -> c.int ---
	SSL_CTX_set_verify :: proc(ctx: SSL_CTX, mode: c.int, callback: rawptr) ---
	SSL_CTX_set_min_proto_version :: proc(ctx: SSL_CTX, version: u16) -> c.int ---

	// ClientHello knobs (#6).
	SSL_CTX_set_strict_cipher_list :: proc(ctx: SSL_CTX, str: cstring) -> c.int ---
	SSL_CTX_set1_group_ids :: proc(ctx: SSL_CTX, group_ids: [^]u16, num_group_ids: c.size_t) -> c.int ---
	SSL_CTX_set_verify_algorithm_prefs :: proc(ctx: SSL_CTX, prefs: [^]u16, num_prefs: c.size_t) -> c.int ---
	// Returns 0 on success — the inverse of every other setter here.
	SSL_CTX_set_alpn_protos :: proc(ctx: SSL_CTX, protos: [^]u8, protos_len: c.size_t) -> c.int ---
	SSL_CTX_set_grease_enabled :: proc(ctx: SSL_CTX, enabled: c.int) ---
	SSL_CTX_set_permute_extensions :: proc(ctx: SSL_CTX, enabled: c.int) ---
	SSL_CTX_enable_ocsp_stapling :: proc(ctx: SSL_CTX) ---
	SSL_CTX_enable_signed_cert_timestamps :: proc(ctx: SSL_CTX) ---
	SSL_CTX_set1_requested_trust_anchors :: proc(ctx: SSL_CTX, ids: [^]u8, ids_len: c.size_t) -> c.int ---
	SSL_CTX_add_cert_compression_alg :: proc(ctx: SSL_CTX, alg_id: u16, compress: rawptr, decompress: Cert_Decompress_Proc) -> c.int ---
	SSL_CTX_set_session_cache_mode :: proc(ctx: SSL_CTX, mode: c.int) -> c.int ---
	SSL_CTX_sess_set_new_cb :: proc(ctx: SSL_CTX, cb: New_Session_Proc) ---
	SSL_set_enable_ech_grease :: proc(ssl: SSL, enable: c.int) ---
	SSL_set_server_padding_request :: proc(ssl: SSL, num_bytes: u16) ---
	CRYPTO_BUFFER_alloc :: proc(out_data: ^[^]u8, len: c.size_t) -> CRYPTO_BUFFER ---
	CRYPTO_BUFFER_free :: proc(buf: CRYPTO_BUFFER) ---

	SSL_new :: proc(ctx: SSL_CTX) -> SSL ---
	SSL_free :: proc(ssl: SSL) ---
	SSL_set_fd :: proc(ssl: SSL, fd: c.int) -> c.int ---
	SSL_set1_host :: proc(ssl: SSL, hostname: cstring) -> c.int ---
	SSL_get0_param :: proc(ssl: SSL) -> X509_VERIFY_PARAM ---
	X509_VERIFY_PARAM_set1_ip_asc :: proc(param: X509_VERIFY_PARAM, ipasc: cstring) -> c.int ---
	SSL_set_tlsext_host_name :: proc(ssl: SSL, name: cstring) -> c.int ---
	SSL_get_servername :: proc(ssl: SSL, type: c.int) -> cstring ---
	SSL_set_session :: proc(ssl: SSL, session: SSL_SESSION) -> c.int ---
	SSL_SESSION_free :: proc(session: SSL_SESSION) ---
	SSL_connect :: proc(ssl: SSL) -> c.int ---
	SSL_read :: proc(ssl: SSL, buf: rawptr, num: c.int) -> c.int ---
	SSL_write :: proc(ssl: SSL, buf: rawptr, num: c.int) -> c.int ---
	SSL_get_error :: proc(ssl: SSL, ret: c.int) -> c.int ---

	// X509 store access, used by the platform root-loading hook
	// (tls_load_platform_roots) to inject CA certificates the default verify paths
	// don't cover — notably the native Windows certificate store.
	SSL_CTX_get_cert_store :: proc(ctx: SSL_CTX) -> X509_STORE ---
	X509_STORE_add_cert :: proc(store: X509_STORE, x: X509) -> c.int ---
	d2i_X509 :: proc(px: ^X509, in_: ^[^]byte, len: c.long) -> X509 ---
	X509_free :: proc(x: X509) ---

	// The thread's error queue: cleared before an SSL call so a stale entry cannot be
	// read as this call's.
	ERR_clear_error :: proc() ---
	ERR_peek_error :: proc() -> u32 ---
}

// g_tls_ctx is a process-wide client context, created lazily on the first https://
// fetch. SSL_CTX is reference-counted and safe to share across the SSL_new of every
// request. It is never freed — it lives for the process, like g_fetch_cancel_class.
@(private = "file")
g_tls_ctx: SSL_CTX
// g_tls_ctx_once makes the lazy build race-safe when several threads' (page dispatcher
// workers') first https fetches collide. A failed build leaves g_tls_ctx nil and is not
// retried (every step is deterministic, not transient).
@(private = "file")
g_tls_ctx_once: sync.Once

// The client session cache (profile.session_resumption): the newest resumable session
// per SNI host name, so a second connection to a host offers a TLS 1.3 PSK / ticket as
// Chrome does. BoringSSL keeps no client-side cache of its own; it hands each new
// session to tls_on_new_session. Process-wide like the context, guarded by a mutex
// because every page worker's connections land here. Keys are cloned through the heap
// allocator explicitly: the callback runs under runtime.default_context().
@(private = "file")
g_sessions: map[string]SSL_SESSION
@(private = "file")
g_sessions_mu: sync.Mutex
// A bound on the cache, so a crawl over many hosts holds at most this many sessions
// (a few KB each). Past it an arbitrary entry is dropped — a lost resumption is a full
// handshake, never a failure.
@(private = "file")
SESSION_CACHE_MAX :: 256

// tls_client_ctx returns the shared client SSL_CTX, building it on first use: the
// default profile's ClientHello, system trust store for verification, peer
// verification on (so a bad cert fails the handshake), and a TLS 1.2 floor. Returns
// nil if the context could not be created. set_default_verify_paths honours the
// SSL_CERT_FILE / SSL_CERT_DIR environment variables.
//
// TRUST STORE: set_default_verify_paths reads BoringSSL's compiled-in locations
// (/etc/ssl/cert.pem, /etc/ssl/certs), which hold the distro roots on Debian/Ubuntu
// and Fedora alike, but NOT the native Windows certificate store. So we then call the
// platform root hook (tls_load_platform_roots): a no-op on Linux, and on Windows it
// loads the machine ROOT/CA stores into this context's X509_STORE.
tls_client_ctx :: proc() -> SSL_CTX {
	sync.once_do(&g_tls_ctx_once, tls_build_ctx)
	return g_tls_ctx
}

// tls_new_client builds a per-request SSL bound to the connected socket `fd`, with SNI
// and certificate hostname verification set to `host`, and the profile's per-connection
// ClientHello settings. Returns nil on any setup failure. The returned SSL must be
// freed with SSL_free (see fetch_tls_cleanup).
tls_new_client :: proc(fd: uintptr, host: string) -> SSL {
	ctx := tls_client_ctx()

	if ctx == nil {
		return nil
	}

	ssl := SSL_new(ctx)

	if ssl == nil {
		return nil
	}

	// SSL_set_fd takes an int. On Windows req.fd is a SOCKET (a uintptr-wide kernel
	// handle); narrowing to c.int is the documented convention and real socket values
	// fit.
	if SSL_set_fd(ssl, c.int(fd)) != 1 {
		SSL_free(ssl)
		return nil
	}

	// Verification needs a NUL-terminated host. BoringSSL copies it into its own
	// storage, so a temp-allocator cstring scoped to this proc is sufficient.
	chost, clone_err := strings.clone_to_cstring(host, context.temp_allocator)

	if clone_err != nil {
		SSL_free(ssl)
		return nil
	}

	// An IP-literal host verifies against the certificate's iPAddress SAN (not a DNS
	// name) and must NOT be sent as SNI (RFC 6066 forbids IP literals there). A DNS
	// name uses SNI + DNS-name verification. Fail closed: if any of these setup calls
	// fails we must not proceed with weaker (or no) verification.
	if tls_host_is_ip(host) {
		if X509_VERIFY_PARAM_set1_ip_asc(SSL_get0_param(ssl), chost) != 1 {
			SSL_free(ssl)
			return nil
		}
	} else {
		if SSL_set_tlsext_host_name(ssl, chost) != 1 || SSL_set1_host(ssl, chost) != 1 {
			SSL_free(ssl)
			return nil
		}

		tls_resume_session(ssl, host)
	}

	tls_configure_ssl(ssl, &profile.default_profile().tls)
	return ssl
}

// tls_host_is_ip reports whether host is an IPv4 or IPv6 literal (so it should be
// verified as an IP address rather than a DNS name). The transport delivers IPv6
// literals bracket-stripped (e.g. "::1"), matching net.parse_ip6_address.
tls_host_is_ip :: proc(host: string) -> bool {
	if _, ok := net.parse_ip4_address(host); ok {
		return true
	}

	if _, ok := net.parse_ip6_address(host); ok {
		return true
	}

	return false
}

// tls_configure_ctx applies a profile's context-wide ClientHello settings. false when
// BoringSSL rejects one, which fails the context closed: a half-applied profile would
// send a ClientHello that matches no browser, which is worse than no HTTPS.
//
// Node:
//   n/a — the oracle is Chrome 158's recorded ClientHello
//   (tests/tls/chrome-158-linux.clienthello.hex); pkg/tls/fingerprint_test.odin
//   compares Larva's against it field by field and by JA4.
// Deviates:
//   ALPN offers http/1.1 only and no ALPS is sent, until H2 (#7): JA4 reads `h1` for
//   Chrome's `h2` and counts one extension fewer. Pinned by fingerprint_test.odin.
tls_configure_ctx :: proc(ctx: SSL_CTX, p: ^profile.TLS_Profile) -> bool {
	if SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION) != 1 {
		return false
	}

	if p.cipher_list != nil && SSL_CTX_set_strict_cipher_list(ctx, p.cipher_list) != 1 {
		return false
	}

	if len(p.groups) > 0 && SSL_CTX_set1_group_ids(ctx, raw_data(p.groups), c.size_t(len(p.groups))) != 1 {
		return false
	}

	if len(p.sigalgs) > 0 &&
	   SSL_CTX_set_verify_algorithm_prefs(ctx, raw_data(p.sigalgs), c.size_t(len(p.sigalgs))) != 1 {
		return false
	}

	if len(p.alpn) > 0 && SSL_CTX_set_alpn_protos(ctx, raw_data(p.alpn), c.size_t(len(p.alpn))) != 0 {
		return false
	}

	if len(p.trust_anchors) > 0 &&
	   SSL_CTX_set1_requested_trust_anchors(ctx, raw_data(p.trust_anchors), c.size_t(len(p.trust_anchors))) != 1 {
		return false
	}

	// Advertised only where a decoder is linked (tls_brotli_decompress is nil on a
	// target without one): offering an algorithm we then fail to decode would turn a
	// server's compressed Certificate into a handshake failure.
	if p.cert_compression_brotli && tls_brotli_decompress != nil {
		if SSL_CTX_add_cert_compression_alg(ctx, TLSEXT_cert_compression_brotli, nil, tls_brotli_decompress) != 1 {
			return false
		}
	}

	SSL_CTX_set_grease_enabled(ctx, c.int(p.grease))
	SSL_CTX_set_permute_extensions(ctx, c.int(p.permute_extensions))

	if p.ocsp_stapling {
		SSL_CTX_enable_ocsp_stapling(ctx)
	}

	if p.signed_cert_timestamps {
		SSL_CTX_enable_signed_cert_timestamps(ctx)
	}

	if p.session_resumption {
		SSL_CTX_set_session_cache_mode(ctx, SSL_SESS_CACHE_CLIENT)
		SSL_CTX_sess_set_new_cb(ctx, tls_on_new_session)
	}

	return true
}

// tls_configure_ssl applies the settings BoringSSL takes only per connection.
tls_configure_ssl :: proc(ssl: SSL, p: ^profile.TLS_Profile) {
	SSL_set_enable_ech_grease(ssl, c.int(p.ech_grease))

	if p.server_padding_request >= 0 {
		SSL_set_server_padding_request(ssl, u16(p.server_padding_request))
	}
}

@(private = "file")
tls_build_ctx :: proc() {
	method := TLS_method()

	if method == nil {
		return
	}

	ctx := SSL_CTX_new(method)

	if ctx == nil {
		return
	}

	// Fail closed if the trust store can't be loaded (verification would have nothing
	// to check against) or the profile can't be applied.
	if SSL_CTX_set_default_verify_paths(ctx) != 1 || !tls_configure_ctx(ctx, &profile.default_profile().tls) {
		SSL_CTX_free(ctx)
		return
	}

	g_sessions = make(map[string]SSL_SESSION, 16, runtime.heap_allocator())
	// Add any platform-native roots (Windows cert store) on top of the defaults.
	// Best-effort: if it loads nothing, a missing root fails the handshake closed — it
	// never weakens verification.
	tls_load_platform_roots(ctx)
	SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, nil)
	g_tls_ctx = ctx
}

// tls_resume_session offers the cached session for `host`, if any. SSL_set_session
// takes its own reference, so the cache keeps its one.
@(private = "file")
tls_resume_session :: proc(ssl: SSL, host: string) {
	sync.guard(&g_sessions_mu)

	if sess, ok := g_sessions[host]; ok {
		SSL_set_session(ssl, sess)
	}
}

// tls_on_new_session stores a session the server just issued, keyed by the SNI name
// the connection was made with (an IP-literal connection has none and is not cached).
// Returning 1 takes ownership of the reference BoringSSL passes in.
@(private = "file")
tls_on_new_session :: proc "c" (ssl: SSL, session: SSL_SESSION) -> c.int {
	context = runtime.default_context()
	name := SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name)

	if name == nil {
		return 0
	}

	host := string(name)
	sync.guard(&g_sessions_mu)

	if old, ok := g_sessions[host]; ok {
		SSL_SESSION_free(old)
		g_sessions[host] = session
		return 1
	}

	if len(g_sessions) >= SESSION_CACHE_MAX {
		for k, v in g_sessions {
			SSL_SESSION_free(v)
			delete_key(&g_sessions, k)
			delete(k, runtime.heap_allocator())
			break
		}
	}

	key, err := strings.clone(host, runtime.heap_allocator())

	if err != nil {
		return 0
	}

	g_sessions[key] = session
	return 1
}
