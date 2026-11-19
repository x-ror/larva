#+build !linux
package larva_http

// No brotli or zstd binding off Linux, as there is no transport (transfer_other.odin):
// neither is offered, so a response using one fails as a coding that was not asked for.
DECODABLE :: Codings{.Gzip, .Deflate}

@(private)
brotli_decode :: proc(input: []byte, out: ^Sink) -> Error {
	return .Decoding
}

@(private)
zstd_decode :: proc(input: []byte, out: ^Sink) -> Error {
	return .Decoding
}
