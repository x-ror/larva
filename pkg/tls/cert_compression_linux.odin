#+build linux
package lava_tls

import "core:c"

// RFC 8879 certificate decompression with brotli, the one algorithm Chrome advertises
// (compress_certificate: brotli). It decodes with the system libbrotlidec that
// pkg/http's content decoding already links (content_coding_linux.odin); the one-shot
// BrotliDecoderDecompress is declared here because pkg/http imports pkg/tls, not the
// other way round.
foreign import brotlidec "system:brotlidec"

// BrotliDecoderResult: BROTLI_DECODER_RESULT_SUCCESS.
@(private = "file")
BROTLI_DECODER_RESULT_SUCCESS :: 1

@(default_calling_convention = "c")
@(private = "file")
foreign brotlidec {
	BrotliDecoderDecompress :: proc(encoded_size: c.size_t, encoded: [^]u8, decoded_size: ^c.size_t, decoded: [^]u8) -> c.int ---
}

// tls_brotli_decompress is the decompressor registered with
// SSL_CTX_add_cert_compression_alg. BoringSSL bounds uncompressed_len before calling
// (it rejects a claimed size over its certificate-list limit), and the output must be
// exactly that size, as Chrome's own callback requires: a short or long decode is a
// failed handshake, never a truncated chain.
tls_brotli_decompress :: proc "c" (
	ssl: SSL,
	out: ^CRYPTO_BUFFER,
	uncompressed_len: c.size_t,
	input: [^]u8,
	in_len: c.size_t,
) -> c.int {
	data: [^]u8
	buf := CRYPTO_BUFFER_alloc(&data, uncompressed_len)

	if buf == nil {
		return 0
	}

	n := uncompressed_len

	if BrotliDecoderDecompress(in_len, input, &n, data) != BROTLI_DECODER_RESULT_SUCCESS || n != uncompressed_len {
		CRYPTO_BUFFER_free(buf)
		return 0
	}

	out^ = buf
	return 1
}
