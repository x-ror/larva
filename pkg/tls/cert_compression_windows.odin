#+build windows
package lava_tls

// No brotli decoder is linked on Windows (pkg/http's content decoding is Linux-only),
// so certificate compression is not advertised there: tls_configure_ctx skips a nil
// decompressor. The ClientHello then lacks compress_certificate — a fingerprint
// difference from Chrome on Windows until a decoder is linked.
tls_brotli_decompress: Cert_Decompress_Proc = nil
