// Linux-only: blocks pool workers on FIFOs (posix.mkfifo) and on a stub resolv.conf
// (core:net reads net.dns_configuration only on Linux).
#+build linux
package main

import "core:fmt"
import "core:net"
import "core:os"
import "core:strings"
import "core:sync"
import "core:sys/posix"
import "core:testing"
import "core:thread"
import "core:time"
import eventloop "lava:pkg/runtime/eventloop"
import lava "lava:pkg/runtime"

// Pins the Pool_Cancel hooks fs.readFile, fs.writeFile and dns.lookup register with the
// loop's pool (#34, ported from larva#49). eventloop.close_begin must release the JS
// callback of a job a worker is still running — on the loop thread, while the context
// lives — rather than leave it to the job's dispose, which runs only once the worker
// exits: in close_finish, or on the last worker of a detached loop, possibly after the
// context and its VM are gone.
//
// LAVA-ONLY and not oracle-able: eval runs both halves of the teardown back to back
// with its context alive, so in Lava the cancel only moves the unprotect earlier — no
// script can see it. What the test can see is the request itself: a watcher thread
// reads req.callback while the worker is still blocked (in open() on a FIFO nobody has
// opened the other end of, or in a lookup against a resolver that never answers) and
// so before any dispose can run. A nil there is the cancel; a callback still set when
// the watcher gives up means close_begin left it protected. The watcher then unblocks
// the worker, so a missing hook fails the assertion instead of hanging close_finish.

@(private = "file")
Watch :: struct {
	loop:     ^eventloop.Loop,
	// Offset of the request's `callback` field; all three request structs differ.
	field:    uintptr,
	// Unblocks the worker once the watch is over (nil: the job ends on its own).
	release:  proc(w: ^Watch),
	fifo:     string,
	fifo_fd:  posix.FD,
	started:  bool, // a worker had taken the job by the time eval tore the loop down
	released: bool, // atomic: req.callback went nil while the worker was still blocked
	th:       ^thread.Thread,
}

// watch_pre_run runs on the loop thread after the script, before the loop would run.
// It waits for the one pool job to be taken by a worker (so close_begin cancels it
// rather than disposing it outright), starts the watcher on that job's request, and
// returns false: eval skips the loop and goes straight to its deferred teardown.
@(private = "file")
watch_pre_run :: proc(user_data: rawptr) -> bool {
	w := cast(^Watch)user_data
	pool := &w.loop.pool
	if len(pool.outstanding) != 1 do return false
	job := pool.outstanding[0]
	deadline := time.tick_add(time.tick_now(), 2 * time.Second)
	for {
		sync.lock(&pool.mutex)
		running := job.running
		sync.unlock(&pool.mutex)
		if running do break
		if time.tick_diff(time.tick_now(), deadline) <= 0 do return false
		time.sleep(time.Millisecond)
	}
	w.started = true
	slot := cast(^rawptr)(uintptr(job.user_data) + w.field)
	w.th = thread.create_and_start_with_poly_data2(w, slot, watch_proc)
	return false
}

// watch_proc polls the request's callback for 2 s — close_begin runs right after
// watch_pre_run returns, so an honest cancel shows up within milliseconds — then lets
// the worker go. The request stays valid throughout: dispose frees it only after the
// worker has exited, and the worker is still blocked until release below.
@(private = "file")
watch_proc :: proc(w: ^Watch, slot: ^rawptr) {
	deadline := time.tick_add(time.tick_now(), 2 * time.Second)
	for time.tick_diff(time.tick_now(), deadline) > 0 {
		if sync.atomic_load(slot) == nil {
			sync.atomic_store(&w.released, true)
			break
		}
		time.sleep(time.Millisecond)
	}
	if w.release != nil do w.release(w)
}

// A reader blocked in open(O_RDONLY) gets through once a writer opens; the writer
// closes at once, so the read sees EOF.
@(private = "file")
release_reader :: proc(w: ^Watch) {
	deadline := time.tick_add(time.tick_now(), 2 * time.Second)
	for time.tick_diff(time.tick_now(), deadline) > 0 {
		fd := posix.open(strings.clone_to_cstring(w.fifo, context.temp_allocator), {.WRONLY, .NONBLOCK})
		if fd >= 0 {
			posix.close(fd)
			return
		}
		time.sleep(time.Millisecond)
	}
}

// A writer blocked in open(O_WRONLY) gets through once a reader opens. The read end
// stays open until the test has joined the worker (eval's close_finish): closing it
// first would hand the worker's write an EPIPE, or the process a SIGPIPE.
@(private = "file")
release_writer :: proc(w: ^Watch) {
	w.fifo_fd = posix.open(strings.clone_to_cstring(w.fifo, context.temp_allocator), {.NONBLOCK})
}

@(private = "file")
make_test_fifo :: proc(t: ^testing.T, name: string) -> string {
	path := fmt.aprintf("/tmp/lava-cancel-%d-%s.fifo", os.get_pid(), name)
	os.remove(path)
	if posix.mkfifo(strings.clone_to_cstring(path, context.temp_allocator), {.IRUSR, .IWUSR}) != .OK {
		delete(path)
		testing.fail_now(t, "mkfifo failed")
	}
	return path
}

@(private = "file")
run_watched :: proc(t: ^testing.T, w: ^Watch, src: string, what: string, loc := #caller_location) {
	loop := eventloop.init()
	w.loop = &loop
	defer w.loop = nil
	w.fifo_fd = -1
	result := lava.eval(src, what, &loop, false, nil, watch_pre_run, w)
	lava.result_destroy(&result)
	if w.th != nil do thread.destroy(w.th)
	if w.fifo_fd >= 0 do posix.close(w.fifo_fd)
	testing.expectf(t, w.started, "%s: no pool worker took the job", what, loc = loc)
	testing.expectf(
		t,
		sync.atomic_load(&w.released),
		"%s: close_begin left the callback of a job its worker is still running protected (no Pool_Cancel)",
		what,
		loc = loc,
	)
}

@(test)
fs_read_file_cancel_releases_the_callback_of_a_blocked_read :: proc(t: ^testing.T) {
	fifo := make_test_fifo(t, "read")
	defer {
		os.remove(fifo)
		delete(fifo)
	}
	w := Watch {
		field   = offset_of(lava.FS_Read_Request, callback),
		release = release_reader,
		fifo    = fifo,
	}
	src := fmt.tprintf("require('fs').readFile(%q, () => {{}});", fifo)
	run_watched(t, &w, src, "<fs.readFile>")
}

@(test)
fs_write_file_cancel_releases_the_callback_of_a_blocked_write :: proc(t: ^testing.T) {
	fifo := make_test_fifo(t, "write")
	defer {
		os.remove(fifo)
		delete(fifo)
	}
	w := Watch {
		field   = offset_of(lava.FS_Op_Request, callback),
		release = release_writer,
		fifo    = fifo,
	}
	src := fmt.tprintf("require('fs').writeFile(%q, 'x', () => {{}});", fifo)
	run_watched(t, &w, src, "<fs.writeFile>")
}

// core:net reads its nameservers from net.dns_configuration.resolv_conf on every
// lookup, so a file naming a loopback address with nothing on port 53 makes a lookup
// wait out core:net's receive timeout — no resolver hook needed. The setting is
// process-wide; only names absent from /etc/hosts reach it, and no other test
// resolves one (dns_alloc_test uses an IP literal and `localhost`).
@(test)
dns_lookup_cancel_releases_the_callback_of_a_hanging_lookup :: proc(t: ^testing.T) {
	conf := fmt.aprintf("/tmp/lava-cancel-%d-resolv.conf", os.get_pid())
	if err := os.write_entire_file(conf, transmute([]u8)string("nameserver 127.77.0.1\n")); err != nil {
		delete(conf)
		testing.fail_now(t, "could not write the stub resolv.conf")
	}
	saved := net.dns_configuration.resolv_conf
	net.dns_configuration.resolv_conf = conf
	defer {
		net.dns_configuration.resolv_conf = saved
		os.remove(conf)
		delete(conf)
	}
	w := Watch {
		field = offset_of(lava.Dns_Lookup_Request, callback),
	}
	run_watched(t, &w, "require('dns').lookup('lava-cancel-hang.test', () => {});", "<dns.lookup>")
}
