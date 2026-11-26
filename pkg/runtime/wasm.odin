package lava_runtime

import "base:runtime"
import "core:c"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// WebAssembly.compile and WebAssembly.instantiate for a page (#97).
//
// JSC's own asynchronous versions compile on a worker and settle from the thread's
// WTF::RunLoop. In this embedding that settlement runs page code — an instantiate's
// start function and imports, a `then` getter a page puts on WebAssembly.Module.prototype
// during the resolve, a species constructor — at thread level: outside the page's CPU
// window, after the page has closed with no execution limit armed, or on the reused VM
// under the next page's limits (#97 review, safety F1/F2: a budget bypass, a thread
// stall, and a kill charged to the wrong page; reproduced, pinned by
// cmd/lava/wasm_page_test.odin). So these two replace the engine's and never touch the
// RunLoop:
//   - the module is compiled synchronously (`new WebAssembly.Module`, captured before
//     page code) inside the caller's own entry: charged to its budget, under its limits;
//   - the promise is settled one task later by a task on the page's own loop, which runs
//     inside one of the page's ticks — and an instantiate's Instance (its imports and
//     start function) is created there, as Chrome runs it in that later task;
//   - a page that closes first drops its jobs with its Runtime_State: no task runs after
//     close_begin, and destroy_runtime_state releases what the jobs held.
// Each job is its own task, as each of Chrome's is. Nothing is held for a promise a page
// can hijack (review F5): the loop stays alive for the posted task only.
//
// Host functions (host_native_create), not JS: a page sees JSC's own `function compile()
// { [native code] }`, length 1, no `prototype`, `new` refused, and no internal frame or
// source in a stack or message (review F1-F3). Pinned against Chrome 158 by
// tests/web/cases/wasm-async.js and wasm-errors.js.
//
// Deviates (engine traits, not this file's): a CompileError or LinkError carries JSC's
// text, not V8's; compileStreaming/instantiateStreaming do not exist (JSC GTK has none,
// and Chrome's take a Response — not implemented here). The import object is read when
// the Instance is made, in the later task; Chrome reads it in the call itself, so a
// getter on it runs later in Lava (unpinned: no recorded case observes it). The module
// is compiled during the call rather than off-thread, so a large module costs the
// calling entry its compile time — which is the point: it is charged.

@(private = "file")
Wasm_Job_Kind :: enum u8 {
	// Resolve or reject with `value`.
	Settle,
	// Make an Instance of the Module in `value` and resolve with it.
	Instantiate,
	// The same, resolving with {module, instance}.
	Instantiate_Bytes,
}

// Wasm_Job is one settlement owed to a page. Every JS value in it is GC-protected from
// enqueue until it runs or the page's Runtime_State is destroyed — exactly one unprotect
// each, on either path (wasm_job_release).
Wasm_Job :: struct {
	kind:    Wasm_Job_Kind,
	ok:      bool,
	resolve: jsc.JSObjectRef,
	reject:  jsc.JSObjectRef,
	value:   jsc.JSValueRef,
	imports: jsc.JSValueRef,
}

// Chrome 158's messages for a rejection a page can cause without a malformed module,
// recorded in tests/web/cases/wasm-errors.expected.
@(private = "file")
COMPILE_ARG0 :: "WebAssembly.compile(): Argument 0 must be a buffer source"
@(private = "file")
INSTANTIATE_ARG0 :: "WebAssembly.instantiate(): Argument 0 must be a buffer source or a WebAssembly.Module object"
@(private = "file")
INSTANTIATE_ARG1 :: "WebAssembly.instantiate(): Argument 1 must be an object"

// install_wasm swaps the engine's WebAssembly.compile/instantiate for this file's, and
// captures WebAssembly.Module and WebAssembly.Instance for them. Runs while the context is
// still the runtime's alone (install_internal_modules, before any page script), so the
// captures are the engine's own. The replaced properties keep their attributes: an
// existing writable property is overwritten in place.
install_wasm :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) {
	if state == nil {
		return
	}

	global := jsc.JSContextGetGlobalObject(ctx)
	wasm := get_named(ctx, global, "WebAssembly")

	if wasm == nil || !jsc.JSValueIsObject(ctx, wasm) {
		return
	}

	ns := cast(jsc.JSObjectRef)wasm
	module := get_named(ctx, ns, "Module")
	instance := get_named(ctx, ns, "Instance")

	if !is_constructor(ctx, module) || !is_constructor(ctx, instance) {
		return
	}

	compile := host_native_create(ctx, "compile", wasm_compile_cb, 1, constructible = false)
	instantiate := host_native_create(ctx, "instantiate", wasm_instantiate_cb, 1, constructible = false)

	// No host path (another platform, or the private ABI missing): the engine's own stay,
	// and so does what they did before (on WebKitGTK, never settling).
	if compile == nil || instantiate == nil {
		return
	}

	jsc.JSValueProtect(ctx, module)
	jsc.JSValueProtect(ctx, instance)
	state.wasm_module = module
	state.wasm_instance = instance
	set_named(ctx, ns, "compile", cast(jsc.JSValueRef)compile)
	set_named(ctx, ns, "instantiate", cast(jsc.JSValueRef)instantiate)
}

// wasm_release_jobs drops every job a page still owed when its Runtime_State goes:
// destroy_runtime_state, with the context alive.
wasm_release_jobs :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) {
	for &job in state.wasm_jobs {
		wasm_job_release(ctx, &job)
	}
	delete(state.wasm_jobs)
	state.wasm_jobs = nil
	unprotect_before_eval_exit(ctx, state.wasm_module)
	unprotect_before_eval_exit(ctx, state.wasm_instance)
	state.wasm_module = nil
	state.wasm_instance = nil
}

// compile(bytes) -> Promise<Module>.
@(private = "file")
wasm_compile_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := get_state_from_ctx(ctx)

	if state == nil || state.wasm_module == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	resolve, reject: jsc.JSObjectRef
	promise := jsc.JSObjectMakeDeferredPromise(ctx, &resolve, &reject, nil)

	if promise == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	module, failure, killed := wasm_compile(ctx, state, arg_or_undefined(ctx, arguments, argument_count, 0), COMPILE_ARG0)

	if killed != nil {
		exception^ = killed
		return jsc.JSValueMakeUndefined(ctx)
	}

	if failure != nil {
		wasm_enqueue(ctx, state, {kind = .Settle, resolve = resolve, reject = reject, value = failure})
	} else {
		wasm_enqueue(ctx, state, {kind = .Settle, ok = true, resolve = resolve, reject = reject, value = module})
	}

	return cast(jsc.JSValueRef)promise
}

// instantiate(bytes | module, imports) -> Promise<{module, instance} | Instance>.
@(private = "file")
wasm_instantiate_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	state := get_state_from_ctx(ctx)

	if state == nil || state.wasm_module == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	resolve, reject: jsc.JSObjectRef
	promise := jsc.JSObjectMakeDeferredPromise(ctx, &resolve, &reject, nil)

	if promise == nil {
		return jsc.JSValueMakeUndefined(ctx)
	}

	source := arg_or_undefined(ctx, arguments, argument_count, 0)
	imports := arg_or_undefined(ctx, arguments, argument_count, 1)
	job := Wasm_Job {
		resolve = resolve,
		reject  = reject,
	}

	// Whether `source` is a Module is asked of the engine (instanceof, which may run a
	// page's Symbol.hasInstance — inside this entry, as in Chrome's call).
	exc: jsc.JSValueRef
	is_module := jsc.JSValueIsInstanceOfConstructor(ctx, source, cast(jsc.JSObjectRef)state.wasm_module, &exc)

	if exc != nil {
		if page_stop_if_killed(state) {
			exception^ = exc
			return jsc.JSValueMakeUndefined(ctx)
		}

		job.value = exc
		wasm_enqueue(ctx, state, job)
		return cast(jsc.JSValueRef)promise
	}

	if !is_module {
		module, failure, killed := wasm_compile(ctx, state, source, INSTANTIATE_ARG0)

		if killed != nil {
			exception^ = killed
			return jsc.JSValueMakeUndefined(ctx)
		}

		if failure != nil {
			job.value = failure
			wasm_enqueue(ctx, state, job)
			return cast(jsc.JSValueRef)promise
		}

		source = module
	}

	if !jsc.JSValueIsUndefined(ctx, imports) && !jsc.JSValueIsObject(ctx, imports) {
		job.value = make_native_error(ctx, "TypeError", INSTANTIATE_ARG1)
		wasm_enqueue(ctx, state, job)
		return cast(jsc.JSValueRef)promise
	}

	job.kind = is_module ? .Instantiate : .Instantiate_Bytes
	job.value = source
	job.imports = imports
	wasm_enqueue(ctx, state, job)
	return cast(jsc.JSValueRef)promise
}

// wasm_compile runs `new WebAssembly.Module(source)` in the calling entry.
//
// Returns:
//   module   The Module, when it compiled.
//   failure  What the promise rejects with: the engine's CompileError as it is, or — for
//            a source that is no buffer source, which JSC reports as a TypeError of its
//            own wording — a TypeError carrying Chrome's `message`.
//   killed   The termination exception, when a limit ended the page during the compile:
//            the caller rethrows it, so the page's entry stops as it would anywhere else.
@(private = "file")
wasm_compile :: proc(
	ctx: jsc.JSContextRef,
	state: ^Runtime_State,
	source: jsc.JSValueRef,
	message: string,
) -> (
	module: jsc.JSValueRef,
	failure: jsc.JSValueRef,
	killed: jsc.JSValueRef,
) {
	args := [1]jsc.JSValueRef{source}
	exc: jsc.JSValueRef
	built := jsc.JSObjectCallAsConstructor(ctx, cast(jsc.JSObjectRef)state.wasm_module, 1, raw_data(args[:]), &exc)

	if exc == nil && built != nil {
		return cast(jsc.JSValueRef)built, nil, nil
	}

	if page_stop_if_killed(state) {
		return nil, nil, exc
	}

	type_error := state.error_intrinsics["TypeError"]

	if exc == nil ||
	   (type_error != nil && jsc.JSValueIsInstanceOfConstructor(ctx, exc, cast(jsc.JSObjectRef)type_error, nil)) {
		return nil, make_native_error(ctx, "TypeError", message), nil
	}

	return nil, exc, nil
}

// wasm_enqueue protects what `job` holds and owes the page one more task for it.
@(private = "file")
wasm_enqueue :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State, job: Wasm_Job) {
	job := job
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)job.resolve)
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)job.reject)

	if job.value != nil {
		jsc.JSValueProtect(ctx, job.value)
	}

	if job.imports != nil {
		jsc.JSValueProtect(ctx, job.imports)
	}

	append(&state.wasm_jobs, job)
	wasm_schedule(state)
}

// wasm_schedule posts one task to the page's loop for the next job. post_async from
// the loop's own thread wakes the loop like a worker completion, and the async_begin is
// what keeps the page alive until the task runs; drain_async drops it.
@(private = "file")
wasm_schedule :: proc(state: ^Runtime_State) {
	if state.wasm_scheduled || len(state.wasm_jobs) == 0 || state.loop == nil || state.loop.destroyed {
		return
	}

	state.wasm_scheduled = true
	eventloop.async_begin(state.loop)
	eventloop.post_async(state.loop, wasm_job_task, state)
}

// wasm_job_task runs the page's oldest job, inside one of its ticks: each JSC call
// below is an entry of the page's own, charged and checked (page_checkpoint). The loop
// runs no task after close_begin, which precedes destroy_runtime_state, so `state` is
// live here.
@(private = "file")
wasm_job_task :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	state := cast(^Runtime_State)user_data
	state.wasm_scheduled = false

	if len(state.wasm_jobs) == 0 {
		return
	}

	ctx := state.ctx
	job := state.wasm_jobs[0]
	ordered_remove(&state.wasm_jobs, 0)
	defer wasm_job_release(ctx, &job)
	defer wasm_schedule(state)

	if page_stop_if_killed(state) {
		return
	}

	ok := job.ok
	value := job.value
	exc: jsc.JSValueRef

	if job.kind != .Settle {
		args := [2]jsc.JSValueRef{job.value, job.imports != nil ? job.imports : jsc.JSValueMakeUndefined(ctx)}
		instance := jsc.JSObjectCallAsConstructor(
			ctx,
			cast(jsc.JSObjectRef)state.wasm_instance,
			2,
			raw_data(args[:]),
			&exc,
		)

		if page_checkpoint(state, &exc) {
			return
		}

		if exc != nil {
			value = exc
		} else if job.kind == .Instantiate {
			ok = true
			value = cast(jsc.JSValueRef)instance
		} else {
			// {module, instance}: a plain object, keys in Chrome's order.
			result := jsc.JSObjectMake(ctx, nil, nil)
			set_named(ctx, result, "module", job.value)
			set_named(ctx, result, "instance", cast(jsc.JSValueRef)instance)
			ok = true
			value = cast(jsc.JSValueRef)result
		}
	}

	settle := ok ? job.resolve : job.reject
	args := [1]jsc.JSValueRef{value}
	exc = nil
	jsc.JSObjectCallAsFunction(ctx, settle, nil, 1, raw_data(args[:]), &exc)
	page_checkpoint(state, &exc)
}

// wasm_job_release gives back the job's GC roots: once, after it ran or when its page
// went first.
@(private = "file")
wasm_job_release :: proc(ctx: jsc.JSContextRef, job: ^Wasm_Job) {
	unprotect_before_eval_exit(ctx, cast(jsc.JSValueRef)job.resolve)
	unprotect_before_eval_exit(ctx, cast(jsc.JSValueRef)job.reject)
	unprotect_before_eval_exit(ctx, job.value)
	unprotect_before_eval_exit(ctx, job.imports)
	job^ = {}
}

@(private = "file")
arg_or_undefined :: proc(ctx: jsc.JSContextRef, arguments: [^]jsc.JSValueRef, count: c.size_t, i: int) -> jsc.JSValueRef {
	if int(count) > i && arguments[i] != nil {
		return arguments[i]
	}

	return jsc.JSValueMakeUndefined(ctx)
}

@(private = "file")
is_constructor :: proc(ctx: jsc.JSContextRef, v: jsc.JSValueRef) -> bool {
	return v != nil && jsc.JSValueIsObject(ctx, v) && jsc.JSObjectIsConstructor(ctx, cast(jsc.JSObjectRef)v)
}
