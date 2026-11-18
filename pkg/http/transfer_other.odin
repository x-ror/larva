#+build !linux
package larva_http

import "base:runtime"
import eventloop "lava:pkg/runtime/eventloop"

// No transport off Linux yet: fetch reports it instead of pretending to work.
@(private)
transfer_start :: proc(
	loop: ^eventloop.Loop,
	req: Request,
	url: Url,
	on_done: Done_Proc,
	user_data: rawptr,
	allocator: runtime.Allocator,
) -> Error {
	u := url
	url_destroy(&u, allocator)
	return .No_Transport
}
