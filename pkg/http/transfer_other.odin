#+build !linux
package larva_http

import "base:runtime"
import eventloop "lava:pkg/runtime/eventloop"

@(private)
transfer_start :: proc(
	loop: ^eventloop.Loop,
	req: Request,
	on_done: Done_Proc,
	user_data: rawptr,
	allocator: runtime.Allocator,
) -> (
	ok: bool,
	err: Error,
) {
	return false, .Unsupported
}
