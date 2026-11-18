#+build darwin
package lava_runtime

import "core:c"
import "core:encoding/pem"
import "core:net"
import "core:os"
import "core:strings"
import "core:sys/posix"

// Native Darwin TLS client for the fetch HTTPS transport, built on Apple's
// Security.framework (SecureTransport). A Mac builds and runs HTTPS fetch with no
// external dependency — Security.framework + CoreFoundation ship in the OS and
// verification uses the system keychain.
//
// SecureTransport is chosen over Network.framework because the fetch transport
// already owns a connected non-blocking socket fd: SecureTransport layers TLS over
// caller-supplied I/O callbacks on that fd, whereas Network.framework owns the
// connection lifecycle and would need a transport rewrite (see #143).
//
// Non-blocking model: the I/O callbacks (darwin_ssl_read_cb/write_cb) call recv/send
// on the same non-blocking fd the plaintext path uses and map EAGAIN/EINTR to
// errSSLWouldBlock. SSLHandshake/SSLRead/SSLWrite then surface errSSLWouldBlock to
// the fetch backend (fetch_tls_darwin.odin), which re-arms the kqueue watcher for
// the needed direction and resumes. The blocked direction is recorded in the session
// (`want`) from inside whichever callback returned errSSLWouldBlock, so a TLS write
// that actually needs to read (a renegotiation mid-write) re-arms for read.
//
// Trust evaluation is taken over explicitly (kSSLSessionOptionBreakOnServerAuth):
// the handshake pauses after the server certificate so darwin_tls_verify_peer can
// (1) honor SSL_CERT_FILE anchors for parity with the OpenSSL backend, (2) verify an
// IP-literal host against the cert without having sent it as SNI, and (3) keep the
// evaluation off the network (SecTrustSetNetworkFetchAllowed false) so it never
// blocks the event-loop thread. It still fails closed against the system trust store
// — this is not a verification bypass.

foreign import security "system:Security.framework"
foreign import core_foundation "system:CoreFoundation.framework"

// OSStatus is SInt32 (SecBase.h); errSecSuccess == 0.
OSStatus :: i32
// CoreFoundation Boolean is `unsigned char`; the SecTrust* / SSLSet* booleans and
// SecTrustEvaluateWithError's C `bool` return are all one byte.
Boolean :: b8
// CFIndex is a signed long.
CFIndex :: c.long

// Opaque CoreFoundation / Security handles.
SSLContextRef :: distinct rawptr
SSLConnectionRef :: rawptr
SecTrustRef :: distinct rawptr
SecCertificateRef :: distinct rawptr
SecPolicyRef :: distinct rawptr
CFDataRef :: distinct rawptr
CFArrayRef :: distinct rawptr
CFStringRef :: distinct rawptr
CFErrorRef :: distinct rawptr
CFTypeRef :: rawptr
CFAllocatorRef :: rawptr

SSLProtocolSide :: enum c.int {
	Server = 0,
	Client = 1,
}

SSLConnectionType :: enum c.int {
	Stream   = 0,
	Datagram = 1,
}

// SSLProtocol values (SecureTransport.h). We only name the TLS 1.2 floor used by
// SSLSetProtocolVersionMin; TLS 1.3 is negotiated up automatically.
SSLProtocol :: enum c.int {
	Unknown = 0,
	TLS1    = 4,
	TLS11   = 7,
	TLS12   = 8,
	TLS13   = 10,
}

// SSLSessionOption values (SecureTransport.h). Only BreakOnServerAuth is used: it
// makes SSLHandshake pause and return errSSLPeerAuthCompleted instead of doing the
// built-in trust evaluation, handing control to darwin_tls_verify_peer.
SSLSessionOption :: enum c.int {
	BreakOnServerAuth = 0,
}

CFStringEncoding :: u32
kCFStringEncodingUTF8 :: CFStringEncoding(0x0800_0100)

SSLReadFunc :: #type proc "c" (connection: SSLConnectionRef, data: rawptr, data_length: ^c.size_t) -> OSStatus
SSLWriteFunc :: #type proc "c" (connection: SSLConnectionRef, data: rawptr, data_length: ^c.size_t) -> OSStatus

// CFArray needs a callbacks table; kCFTypeArrayCallBacks (a CoreFoundation global)
// retains/releases CF objects placed in the array. We only ever pass its address.
CFArrayCallBacks :: struct {
	version:          CFIndex,
	retain:           rawptr,
	release:          rawptr,
	copy_description: rawptr,
	equal:            rawptr,
}

// SecureTransport status codes acted on by the fetch backend. Anything else from a
// handshake/read/write is treated as a fatal TLS error.
errSecSuccess :: 0
errSSLWouldBlock :: -9803 // I/O callback returned EAGAIN — re-arm and resume
errSSLClosedGraceful :: -9805 // peer sent a clean close_notify
errSSLClosedAbort :: -9806 // connection torn down abnormally (reset / socket error)
errSSLClosedNoNotify :: -9816 // connection closed without close_notify (HTTP/1.1 close)
errSSLPeerAuthCompleted :: -9841 // break-on-auth: server cert received, evaluate trust

@(default_calling_convention = "c")
foreign security {
	// alloc is a CFAllocatorRef; nil selects the default allocator.
	SSLCreateContext :: proc(alloc: CFAllocatorRef, protocol_side: SSLProtocolSide, connection_type: SSLConnectionType) -> SSLContextRef ---
	SSLSetIOFuncs :: proc(ctx: SSLContextRef, read_func: SSLReadFunc, write_func: SSLWriteFunc) -> OSStatus ---
	SSLSetConnection :: proc(ctx: SSLContextRef, connection: SSLConnectionRef) -> OSStatus ---
	SSLSetPeerDomainName :: proc(ctx: SSLContextRef, peer_name: cstring, peer_name_len: c.size_t) -> OSStatus ---
	SSLSetProtocolVersionMin :: proc(ctx: SSLContextRef, min_version: SSLProtocol) -> OSStatus ---
	SSLSetSessionOption :: proc(ctx: SSLContextRef, option: SSLSessionOption, value: Boolean) -> OSStatus ---
	SSLCopyPeerTrust :: proc(ctx: SSLContextRef, trust: ^SecTrustRef) -> OSStatus ---
	SSLHandshake :: proc(ctx: SSLContextRef) -> OSStatus ---
	SSLRead :: proc(ctx: SSLContextRef, data: rawptr, data_length: c.size_t, processed: ^c.size_t) -> OSStatus ---
	SSLWrite :: proc(ctx: SSLContextRef, data: rawptr, data_length: c.size_t, processed: ^c.size_t) -> OSStatus ---
	SSLClose :: proc(ctx: SSLContextRef) -> OSStatus ---

	// Trust-evaluation surface for darwin_tls_verify_peer.
	SecCertificateCreateWithData :: proc(allocator: CFAllocatorRef, data: CFDataRef) -> SecCertificateRef ---
	SecPolicyCreateSSL :: proc(server: Boolean, hostname: CFStringRef) -> SecPolicyRef ---
	SecTrustSetPolicies :: proc(trust: SecTrustRef, policies: CFTypeRef) -> OSStatus ---
	SecTrustSetAnchorCertificates :: proc(trust: SecTrustRef, anchor_certificates: CFArrayRef) -> OSStatus ---
	SecTrustSetAnchorCertificatesOnly :: proc(trust: SecTrustRef, anchor_certificates_only: Boolean) -> OSStatus ---
	SecTrustSetNetworkFetchAllowed :: proc(trust: SecTrustRef, allow_fetch: Boolean) -> OSStatus ---
	SecTrustEvaluateWithError :: proc(trust: SecTrustRef, error: ^CFErrorRef) -> Boolean ---
}

@(default_calling_convention = "c")
foreign core_foundation {
	CFRelease :: proc(cf: rawptr) ---
	CFDataCreate :: proc(allocator: CFAllocatorRef, bytes: [^]u8, length: CFIndex) -> CFDataRef ---
	CFArrayCreate :: proc(allocator: CFAllocatorRef, values: [^]rawptr, num_values: CFIndex, call_backs: ^CFArrayCallBacks) -> CFArrayRef ---
	CFStringCreateWithCString :: proc(allocator: CFAllocatorRef, c_str: cstring, encoding: CFStringEncoding) -> CFStringRef ---
}

foreign core_foundation {
	kCFTypeArrayCallBacks: CFArrayCallBacks
}

// Want is the readiness direction the last errSSLWouldBlock needs. Defaults to
// Write (the first handshake step writes the ClientHello); each I/O callback sets
// it when it blocks so the fetch backend re-arms the correct kqueue filter.
Want :: enum {
	Write,
	Read,
}

// Darwin_TLS_Session is the per-request TLS state, stored in req.tls as an opaque
// rawptr (so the cross-platform Fetch_Request never names a Darwin type), the same
// way the OpenSSL backend stores its ^SSL. Heap-allocated so its address is stable:
// it is handed to SSLSetConnection and dereferenced by the I/O callbacks.
Darwin_TLS_Session :: struct {
	ctx:        SSLContextRef,
	fd:         uintptr,
	is_ip:      bool, // host is an IP literal — verified against an IP SAN, no SNI sent
	want:       Want, // direction of the most recent errSSLWouldBlock
	// SecureTransport's SSLWrite consumes plaintext into internal records that it may
	// only partially flush to the socket before blocking — unlike OpenSSL's socket
	// BIO, which consumes nothing on WANT_WRITE. To keep the OpenSSL-style "retry the
	// same buffer, advance only when fully sent" contract the fetch backend expects,
	// write_skip records how many bytes of the current write buffer SecureTransport
	// has already taken; a retry re-submits only the un-taken tail (or flushes the
	// queue with a zero-length SSLWrite when the whole buffer is taken). See
	// darwin_tls_write_chunk in fetch_tls_darwin.odin.
	write_skip: int,
}

// darwin_ssl_read_cb is SecureTransport's read I/O callback: fill up to
// data_length^ bytes from the socket into data, updating data_length^ with the
// count actually read. recv == 0 (peer FIN) maps to errSSLClosedGraceful; EAGAIN
// maps to errSSLWouldBlock (recording the read direction); EINTR retries. Runs as a
// C callback inside SSLRead/SSLWrite/SSLHandshake, so it uses only contextless
// posix syscalls — no Odin context.
@(private = "file")
darwin_ssl_read_cb :: proc "c" (connection: SSLConnectionRef, data: rawptr, data_length: ^c.size_t) -> OSStatus {
	sess := cast(^Darwin_TLS_Session)connection
	requested := data_length^
	buf := cast([^]byte)data
	total: c.size_t = 0
	status: OSStatus = errSecSuccess
	for total < requested {
		n := posix.recv(posix.FD(sess.fd), rawptr(&buf[total]), requested - total, {})

		if n > 0 {
			total += c.size_t(n)
			continue
		}

		if n == 0 {
			status = errSSLClosedGraceful // orderly peer close
			break
		}
		#partial switch posix.get_errno() {
		case .EINTR:
			continue // interrupted before any byte arrived — retry
		case .EAGAIN:
			// == EWOULDBLOCK on Darwin
			sess.want = .Read
			status = errSSLWouldBlock
		case:
			status = errSSLClosedAbort // reset/socket error — fatal, not a clean EOF
		}
		break
	}
	data_length^ = total
	return status
}

// darwin_ssl_write_cb is SecureTransport's write I/O callback: send up to
// data_length^ bytes from data to the socket, updating data_length^ with the count
// actually sent. SIGPIPE is suppressed via SO_NOSIGPIPE on the socket (see
// fetch_darwin.odin), so a reset peer surfaces as an errno here. EAGAIN maps to
// errSSLWouldBlock (recording the write direction); EINTR retries.
@(private = "file")
darwin_ssl_write_cb :: proc "c" (connection: SSLConnectionRef, data: rawptr, data_length: ^c.size_t) -> OSStatus {
	sess := cast(^Darwin_TLS_Session)connection
	requested := data_length^
	buf := cast([^]byte)data
	total: c.size_t = 0
	status: OSStatus = errSecSuccess
	for total < requested {
		n := posix.send(posix.FD(sess.fd), rawptr(&buf[total]), requested - total, {})

		if n > 0 {
			total += c.size_t(n)
			continue
		}
		#partial switch posix.get_errno() {
		case .EINTR:
			continue // interrupted before any byte was sent — retry
		case .EAGAIN:
			// == EWOULDBLOCK on Darwin
			sess.want = .Write
			status = errSSLWouldBlock
		case:
			status = errSSLClosedAbort // EPIPE/reset — fatal write failure
		}
		break
	}
	data_length^ = total
	return status
}

// darwin_tls_new_client builds a per-request SecureTransport session bound to the
// connected non-blocking socket `fd`. Returns nil on any setup failure; the result
// must be freed with darwin_tls_free (see fetch_tls_cleanup). Trust evaluation runs
// in darwin_tls_verify_peer (break-on-auth); SNI / hostname handling:
//
//   - DNS name: SSLSetPeerDomainName sends SNI and binds the name the certificate is
//     verified against during evaluation.
//   - IP literal: no SNI is sent (RFC 6066), and the IP is matched against the cert's
//     iPAddress SAN by a policy attached in darwin_tls_verify_peer.
darwin_tls_new_client :: proc(fd: uintptr, host: string) -> ^Darwin_TLS_Session {
	ctx := SSLCreateContext(nil, .Client, .Stream)

	if ctx == nil {
		return nil
	}

	sess := new(Darwin_TLS_Session)

	if sess == nil {
		CFRelease(rawptr(ctx))
		return nil
	}

	sess.ctx = ctx
	sess.fd = fd
	sess.want = .Write
	sess.is_ip = darwin_tls_host_is_ip(host)

	// Wire TLS onto the existing fd via the non-blocking I/O callbacks, point the
	// callbacks' connection ref at this session, set the TLS 1.2 floor, and take over
	// trust evaluation (break-on-auth). Fail closed: any setup error tears down rather
	// than proceeding with weaker TLS.
	if SSLSetIOFuncs(ctx, darwin_ssl_read_cb, darwin_ssl_write_cb) != errSecSuccess ||
	   SSLSetConnection(ctx, SSLConnectionRef(sess)) != errSecSuccess ||
	   SSLSetProtocolVersionMin(ctx, .TLS12) != errSecSuccess ||
	   SSLSetSessionOption(ctx, .BreakOnServerAuth, true) != errSecSuccess {
		darwin_tls_free(sess)
		return nil
	}

	// An IP literal must not be sent as SNI; its identity is checked against the
	// cert's iPAddress SAN during verification. A DNS name sets the peer domain name,
	// which sends SNI and binds the verification name. SecureTransport copies the
	// name, so a temp-allocator cstring is fine; fail closed if it can't be set.
	if !sess.is_ip {
		chost, clone_err := strings.clone_to_cstring(host, context.temp_allocator)

		if clone_err != nil {
			darwin_tls_free(sess)
			return nil
		}

		if SSLSetPeerDomainName(ctx, chost, c.size_t(len(host))) != errSecSuccess {
			darwin_tls_free(sess)
			return nil
		}
	}

	return sess
}

// darwin_tls_verify_peer evaluates the server's certificate chain after the
// break-on-auth pause (errSSLPeerAuthCompleted). It fails closed: a chain that does
// not validate against the system trust store (plus any SSL_CERT_FILE anchors), or a
// host/IP that does not match the certificate, returns false and the handshake is
// rejected. `host` is the request host (used to build the IP-SAN policy for an IP
// literal). Network fetching is disabled so evaluation stays local and never blocks
// the event-loop thread (matching OpenSSL's local-only verification).
darwin_tls_verify_peer :: proc(sess: ^Darwin_TLS_Session, host: string) -> bool {
	trust: SecTrustRef

	if SSLCopyPeerTrust(sess.ctx, &trust) != errSecSuccess || trust == nil {
		return false
	}

	defer CFRelease(rawptr(trust))

	// An IP literal had no peer domain name set (no SNI), so the trust object carries
	// no hostname policy. Attach one that checks the IP against the cert's iPAddress
	// SAN — without this the IP identity would go unverified (a chain-only check would
	// accept any root-trusted cert for the IP).
	if sess.is_ip {
		chost, clone_err := strings.clone_to_cstring(host, context.temp_allocator)

		if clone_err != nil {
			return false
		}

		host_cf := CFStringCreateWithCString(nil, chost, kCFStringEncodingUTF8)

		if host_cf == nil {
			return false
		}

		defer CFRelease(rawptr(host_cf))
		policy := SecPolicyCreateSSL(true, host_cf)

		if policy == nil {
			return false
		}

		defer CFRelease(rawptr(policy))

		if SecTrustSetPolicies(trust, CFTypeRef(policy)) != errSecSuccess {
			return false
		}
	}

	// Add SSL_CERT_FILE anchors (if any) on top of the system roots
	// (AnchorCertificatesOnly false), giving the OpenSSL backend's SSL_CERT_FILE
	// behavior. A missing/empty/unparseable file leaves anchors nil and verification
	// falls back to the system trust store — it never weakens verification.
	if anchors := darwin_tls_extra_anchors(); anchors != nil {
		if SecTrustSetAnchorCertificates(trust, anchors) != errSecSuccess {
			return false
		}

		if SecTrustSetAnchorCertificatesOnly(trust, false) != errSecSuccess {
			return false
		}
	}

	// Keep evaluation off the network: no AIA intermediate fetching or OCSP, so it
	// runs synchronously on the loop thread without blocking (and matches OpenSSL,
	// which verifies only the presented chain). The server is expected to send its
	// intermediates, as the OpenSSL path requires too.
	SecTrustSetNetworkFetchAllowed(trust, false)

	err: CFErrorRef
	ok := SecTrustEvaluateWithError(trust, &err)

	if err != nil {
		CFRelease(rawptr(err))
	}

	return bool(ok)
}

// darwin_tls_free closes and releases a session. SSLClose is best-effort (it tries
// to send a close_notify via the write callback; a would-block on the non-blocking
// fd is ignored — we are tearing down). CFRelease frees the context; the fd itself
// is closed separately by the transport after fetch_tls_cleanup.
darwin_tls_free :: proc(sess: ^Darwin_TLS_Session) {
	if sess == nil {
		return
	}

	if sess.ctx != nil {
		SSLClose(sess.ctx)
		CFRelease(rawptr(sess.ctx))
	}

	free(sess)
}

// darwin_tls_host_is_ip reports whether host is an IPv4 or IPv6 literal (so it is
// verified against an iPAddress SAN and no SNI is sent). The transport delivers IPv6
// literals bracket-stripped (e.g. "::1"), matching net.parse_ip6_address. Mirrors
// tls_host_is_ip in the OpenSSL backend.
@(private = "file")
darwin_tls_host_is_ip :: proc(host: string) -> bool {
	if _, ok := net.parse_ip4_address(host); ok {
		return true
	}

	if _, ok := net.parse_ip6_address(host); ok {
		return true
	}

	return false
}

// g_extra_anchors holds the SSL_CERT_FILE certificates as a CFArray of
// SecCertificateRef, built once on the first https fetch and kept for the process
// (like the OpenSSL backend's shared SSL_CTX). nil means no usable extra anchors —
// verification then uses the system trust store alone.
@(private = "file")
g_extra_anchors_built: bool
@(private = "file")
g_extra_anchors: CFArrayRef

// darwin_tls_extra_anchors returns the cached SSL_CERT_FILE anchor array, loading it
// lazily on first use. Loop-thread only (every https fetch is set up there), so the
// lazy init needs no synchronization — same as the OpenSSL backend's g_tls_ctx.
@(private = "file")
darwin_tls_extra_anchors :: proc() -> CFArrayRef {
	if !g_extra_anchors_built {
		g_extra_anchors_built = true
		g_extra_anchors = darwin_tls_load_env_anchors()
	}

	return g_extra_anchors
}

// darwin_tls_load_env_anchors reads SSL_CERT_FILE (a PEM bundle, the same env var the
// OpenSSL backend honors) and returns its certificates as a CFArray, or nil if the
// var is unset/empty/unreadable or holds no parseable certificate. Best-effort and
// additive: it never weakens verification.
@(private = "file")
darwin_tls_load_env_anchors :: proc() -> CFArrayRef {
	path, found := os.lookup_env("SSL_CERT_FILE", context.temp_allocator)

	if !found || path == "" {
		return nil
	}

	data, read_err := os.read_entire_file(path, context.temp_allocator)

	if read_err != nil {
		return nil
	}

	certs: [dynamic]rawptr
	defer delete(certs)
	rest := data
	for len(rest) > 0 {
		blk, remaining, decode_err := pem.decode(rest, context.temp_allocator)

		if decode_err != nil || blk == nil {
			break
		}

		rest = remaining

		if blk.label == pem.LABEL_CERTIFICATE && len(blk.data) > 0 {
			cfdata := CFDataCreate(nil, raw_data(blk.data[:]), CFIndex(len(blk.data)))

			if cfdata != nil {
				cert := SecCertificateCreateWithData(nil, cfdata)
				CFRelease(rawptr(cfdata))

				if cert != nil {
					append(&certs, rawptr(cert))
				}
			}
		}

		pem.block_delete(blk)
	}

	if len(certs) == 0 {
		return nil
	}

	// CFArrayCreate with kCFTypeArrayCallBacks retains each cert, so we release our own
	// references and let the (process-lifetime) array own them.
	arr := CFArrayCreate(nil, raw_data(certs[:]), CFIndex(len(certs)), &kCFTypeArrayCallBacks)
	for cert in certs {
		CFRelease(cert)
	}
	return arr
}
