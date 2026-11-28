#+build !linux
package larva_adapters

// `lava serve` runs its pages on the page dispatcher, which exists only on Linux
// (page_dispatcher_other.odin). Linux-first: elsewhere server_init refuses with a real
// error rather than start a server that could render nothing.

Server :: struct {
	cfg:  Server_Config,
	port: int,
}

server_init :: proc(s: ^Server, cfg: Server_Config) -> (err: string) {
	s^ = {}
	return "lava serve: unsupported on this platform (the page dispatcher is Linux-only)"
}

server_run :: proc(s: ^Server) {}

server_stop :: proc(s: ^Server) {}

server_destroy :: proc(s: ^Server) {}

serve_stop_on_signals :: proc(s: ^Server) -> bool {return false}
