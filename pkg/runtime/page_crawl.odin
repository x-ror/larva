#+build linux
package lava_runtime

import "base:runtime"
import "core:encoding/json"
import "core:strings"
import "core:time"
import html "lava:pkg/html"
import cookie "lava:pkg/http/cookie"
import proxy "lava:pkg/http/proxy"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// A crawl job is one HTML document run as a page on a dispatcher worker, waited on and
// captured: what the HTTP crawling adapter (`lava serve`, pkg/adapters, #15) asks of the
// engine for one request. The adapter fetched the document on its own thread; the page
// runs here as any runner page does — its own VM from the worker's pool, its own loop,
// its CPU budget, the runner's slicing — through a Page_Driver instead of a top-level
// script, so it is ticked beside the worker's other pages. Nothing of it reaches the
// adapter's thread but the job's outputs and the page's Result, both written before
// on_done.
//
// The wait order is #15's production order, cut to what this stage has:
//   load → selector wait → custom script → capture.
// `load` is the HTML loader's (page_html.odin): fired once the loop has idled after
// DOMContentLoaded — there are no subresources to wait for — so a page whose loop never
// idles before then (a setInterval started at parse time) never reaches it and ends at
// its deadline. Network-idle, the actions DSL, the fixed body wait and capture of network
// bodies are later work (#15). Cookies are the session's (Crawl_Job.cookie_jar): the
// adapter captures them from the jar it lent the page.

// Crawl_Outcome is how the driver ended a crawl job. `.None` means it did not: the
// page's Result says why (a limit kill, a cancel, a failed install or parse).
Crawl_Outcome :: enum {
	None,
	// Captured: Crawl_Job.body holds the document, or the script's result.
	Ok,
	// The job's deadline passed before the capture.
	Timeout,
	// The selector is not a valid selector list.
	Selector_Invalid,
	// The loop idled after `load` with no element matching the selector, so none can.
	Selector_Not_Found,
	// The custom script did not compile, rejected, threw, never settled with nothing left
	// to run, or resolved with a value JSON.stringify throws on. `message` says which.
	Script_Error,
	// The document could not be serialized.
	Failed,
}

// Crawl_Job is one request's page: inputs the embedder sets before
// page_dispatcher_submit_crawl, outputs the worker writes before on_done. The embedder
// owns the struct and must keep it, and everything its inputs point to, alive until
// on_done has run; it reads the outputs only after on_done.
Crawl_Job :: struct {
	// The document, UTF-8 (html.decode_document's output).
	document:      []byte,
	// The document's URL: the page's origin (`location`) and its scripts' source name.
	url:           string,
	// A selector list to wait for after `load`; "" for none.
	selector:      string,
	// A custom script's body, run after the selector wait; "" for none. It runs as the
	// body of an async function with `_resolve`, `_reject` and `_delay(ms)` in scope, and
	// the job waits until it calls `_resolve` or `_reject` (#15's page script contract).
	script:        string,
	// Capture the value given to `_resolve`, JSON-serialized, instead of the document.
	script_result: bool,
	// When the job times out, on the monotonic clock.
	deadline:      time.Tick,
	// The session's cookie jar the page's fetch(), XMLHttpRequest and document.cookie use
	// instead of the page's own (Runtime_State.cookie_jar), or nil for the page's own.
	// Borrowed until on_done; read and written on the worker thread while the embedder's
	// thread may use it too, which the jar's own mutex makes safe (pkg/http/cookie).
	cookie_jar:    ^cookie.Jar,
	// The proxy the page's own requests go through, the zero value for none. Its strings
	// are borrowed until on_done.
	proxy:         proxy.Proxy,
	// Owns `body` and `message`. Used from the worker thread, so it must be thread-safe.
	allocator:     runtime.Allocator,
	// Outputs.
	outcome:       Crawl_Outcome,
	body:          string,
	message:       string,
	// The driver's own state.
	phase:         Crawl_Phase,
	script_begun:  bool,
	wake:          eventloop.Timer_ID,
}

// Crawl_Phase is where the driver is in the wait order.
Crawl_Phase :: enum {
	Loading,
	Waiting,
	Script,
}

// CRAWL_SCRIPT_HEAD and CRAWL_SCRIPT_TAIL wrap a custom script: the script body (a JSON
// string literal between them) is compiled as an AsyncFunction taking `_resolve`,
// `_reject` and `_delay`, so a syntax error is a SyntaxError this wrapper catches rather
// than a failed evaluation with no message, and the body cannot close the wrapper's own
// brackets. The completion value is a probe the driver calls between ticks: undefined
// while the promise is pending, then "ok:<json>" or "error:<message>". A value
// JSON.stringify drops (undefined, a function) is reported as `null`.
//
// Deviates:
//   #15's wrapper is `new Promise(async (_resolve, _reject) => { … })`, whose throw is
//   lost (an async executor's rejection is nobody's); here a throw rejects the job.
//   `_scrollBottom`, `_clickElement` and `_sendKeys` are not defined yet. The result is
//   JSON, not a string the script must build. Pinned by cmd/lava/serve_test.odin.
@(private = "file")
CRAWL_SCRIPT_HEAD :: `(() => {
  let state = 0, out = '';
  const settle = (s, v) => { if (state === 0) { state = s; out = v; } };
  const describe = (e) => { try { return String(e); } catch { return 'the script threw a value String() rejects'; } };
  try {
    const AsyncFunction = (async () => {}).constructor;
    const body = new AsyncFunction('_resolve', '_reject', '_delay', `

@(private = "file")
CRAWL_SCRIPT_TAIL :: `);
    const _delay = (ms) => new Promise((r) => setTimeout(r, ms));
    new Promise((_resolve, _reject) => {
      body(_resolve, _reject, _delay).catch(_reject);
    }).then((v) => {
      let json;
      try { json = JSON.stringify(v); } catch (e) { settle(2, 'the result is not JSON-serializable: ' + describe(e)); return; }
      settle(1, json === undefined ? 'null' : json);
    }, (e) => settle(2, describe(e)));
  } catch (e) {
    settle(2, describe(e));
  }
  return () => state === 0 ? undefined : (state === 1 ? 'ok:' : 'error:') + out;
})()`

// page_dispatcher_submit_crawl hands `job` to the least-loaded worker of `d`, as a page
// the crawl driver runs (page_dispatcher_submit_driven).
//
// Params:
//   job     Borrowed until on_done; its inputs are read on the worker thread.
//   limits  As page_dispatcher_submit's: a CPU budget is required.
// Returns:
//   page_dispatcher_submit's contract: true when on_done will run exactly once for
//   `user_data`, by which time the job's outputs are written.
// Deviates:
//   n/a (no oracle): the adapter's own job, pinned by cmd/lava/serve_test.odin.
page_dispatcher_submit_crawl :: proc(
	d: ^Page_Dispatcher,
	job: ^Crawl_Job,
	limits: Page_Limits,
	user_data: rawptr = nil,
) -> bool {
	driver := Page_Driver {
		start  = crawl_start,
		tick   = crawl_tick,
		data   = job,
		name   = job.url,
		origin = job.url,
	}
	return page_dispatcher_submit_driven(d, driver, limits, user_data)
}

// crawl_start parses and scripts the document up to DOMContentLoaded.
@(private = "file")
crawl_start :: proc(page: ^Page, data: rawptr) -> bool {
	job := cast(^Crawl_Job)data
	job.phase = .Loading

	if crawl_expired(job) {
		crawl_end(job, .Timeout, "the page timed out before it started")
		return false
	}

	if job.cookie_jar != nil {
		page.state.cookie_jar = job.cookie_jar
	}

	page.state.proxy = job.proxy

	// No document path: a `src` is never read from the server's disk, so every external
	// script fails its fetch (its `error` event), as page_script.odin does for "".
	return html_page_begin(page, job.document, job.url, "")
}

// crawl_tick is one round of the job: one page tick, then as many steps of the wait order
// as are ready.
@(private = "file")
crawl_tick :: proc(page: ^Page, data: rawptr) -> (alive: bool, did_work: bool) {
	job := cast(^Crawl_Job)data

	if crawl_expired(job) {
		crawl_end(job, .Timeout, "the page did not finish before its timeout")
		return false, true
	}

	crawl_arm_wake(job, page)
	ticked: bool
	ticked, did_work = page_tick(page)

	if page.finished {
		return false, did_work
	}

	for {
		switch job.phase {
		case .Loading:
			// A tick that ran something may have left more for the next one.
			if ticked {
				return true, did_work
			}

			if !html_page_fire_load(page) {
				return false, true
			}

			job.phase = .Waiting
			did_work = true
		case .Waiting:
			if job.selector != "" {
				found, valid := crawl_selector_matches(page, job.selector)

				if !valid {
					crawl_end(job, .Selector_Invalid, "not a valid selector")
					return false, true
				}

				if !found {
					if !crawl_loop_busy(page) {
						crawl_end(
							job,
							.Selector_Not_Found,
							"no element matched the selector before the page went idle",
						)
						return false, true
					}

					return true, did_work
				}
			}

			job.phase = .Script
		case .Script:
			if job.script == "" {
				crawl_capture(job, page)
				return false, true
			}

			if !job.script_begun {
				job.script_begun = true
				did_work = true

				if !crawl_script_begin(job, page) {
					return false, true
				}
			}

			state, text := crawl_script_probe(job, page)

			if page.finished {
				delete(text, job.allocator)
				return false, true
			}

			switch state {
			case .Pending:
				if !crawl_loop_busy(page) {
					crawl_end(job, .Script_Error, "the script never settled: the page has nothing left to run")
					return false, true
				}

				return true, did_work
			case .Rejected:
				crawl_end(job, .Script_Error, "")
				job.message = text
				return false, true
			case .Resolved:
				if job.script_result {
					job.outcome = .Ok
					job.body = text
				} else {
					delete(text, job.allocator)
					crawl_capture(job, page)
				}

				return false, true
			}
		}
	}
}

// crawl_capture serializes the document into job.body.
@(private = "file")
crawl_capture :: proc(job: ^Crawl_Job, page: ^Page) {
	context.allocator = job.allocator
	job.body = html_page_view(page, .Serialize)

	if job.body == "" {
		crawl_end(job, .Failed, "the document could not be serialized")
		return
	}

	job.outcome = .Ok
}

@(private = "file")
crawl_end :: proc(job: ^Crawl_Job, outcome: Crawl_Outcome, message: string) {
	job.outcome = outcome

	if message != "" {
		job.message = strings.clone(message, job.allocator)
	}
}

@(private = "file")
crawl_expired :: proc(job: ^Crawl_Job) -> bool {
	return time.tick_diff(time.tick_now(), job.deadline) <= 0
}

// crawl_loop_busy reports whether the page's loop still has something that keeps it
// alive: with nothing, no task can run that would change the document or settle a
// promise, so a wait for either can only end at the deadline — it ends now instead.
@(private = "file")
crawl_loop_busy :: proc(page: ^Page) -> bool {
	loop := page.loop
	return loop != nil && eventloop.has_pending_work(loop) && !loop.backend_error && !loop.force_exit
}

// crawl_arm_wake keeps an unreffed timer on the page's loop due at the job's deadline, so
// a runner blocked on the page's descriptors wakes for it. Unreffed, so the loop still
// reads as idle with it armed; re-armed when page JS cleared it (clearTimeout takes any
// id), as page_run_until does with its own.
@(private = "file")
crawl_arm_wake :: proc(job: ^Crawl_Job, page: ^Page) {
	loop := page.loop

	if loop == nil || eventloop.timer_is_live(loop, job.wake) {
		return
	}

	left := time.duration_milliseconds(time.tick_diff(time.tick_now(), job.deadline))
	job.wake = eventloop.set_timeout(loop, crawl_wake, u64(max(left, 0)) + 1)
	eventloop.timer_unref(loop, job.wake)
}

// crawl_wake does nothing: firing is what ends a runner wait past the deadline.
@(private = "file")
crawl_wake :: proc(loop: ^eventloop.Loop, user_data: rawptr) {}

// crawl_selector_matches runs `css` against the document with the page's own selector
// engine — the one querySelector uses — natively, so no page JS runs for the check.
@(private = "file")
crawl_selector_matches :: proc(page: ^Page, css: string) -> (found: bool, valid: bool) {
	dom := page.state.dom
	sel, compiled := html.compile(&dom.selectors, css)

	if !compiled {
		return false, false
	}

	defer html.selector_destroy(&sel)
	node, searched := html.query_first(&dom.selectors, html.document(&dom.parser), sel)
	return searched && node != nil, true
}

// crawl_script_begin evaluates the wrapped script; its completion value, the probe, stays
// in page.eval_value (protected until page_close). Returns false when the job ended: the
// page was killed, or the wrapper itself failed to evaluate.
@(private = "file")
crawl_script_begin :: proc(job: ^Crawl_Job, page: ^Page) -> bool {
	literal, err := json.marshal(job.script, allocator = context.temp_allocator)

	if err != nil {
		crawl_end(job, .Script_Error, "the script could not be encoded")
		return false
	}

	source := strings.concatenate({CRAWL_SCRIPT_HEAD, string(literal), CRAWL_SCRIPT_TAIL}, context.temp_allocator)
	_, ok := page_eval(page, source, job.url)

	if page.finished {
		return false
	}

	if !ok {
		crawl_end(job, .Script_Error, "the script wrapper failed to evaluate")
		return false
	}

	return true
}

@(private = "file")
Probe_State :: enum {
	Pending,
	Resolved,
	Rejected,
}

// crawl_script_probe calls the probe; `text` (job.allocator) is the JSON result or the
// rejection's message. The call is page JS (a getter on a resolved value ran already, but
// the probe is still the page's function), so it is charged to the page's CPU budget.
@(private = "file")
crawl_script_probe :: proc(job: ^Crawl_Job, page: ^Page) -> (state: Probe_State, text: string) {
	ctx := cast(jsc.JSContextRef)page.ctx
	probe := page.eval_value

	if probe == nil || !jsc.JSValueIsObject(ctx, probe) {
		return .Rejected, strings.clone("the script wrapper returned no probe", job.allocator)
	}

	raw: string
	allocated: bool
	exception: jsc.JSValueRef
	vm_cpu_enter(page.vm)
	value := jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)probe, nil, 0, nil, &exception)

	// Only a string is converted: it runs no page code, as converting an object would.
	if exception == nil && value != nil && jsc.JSValueIsString(ctx, value) {
		raw, allocated = value_to_string(ctx, value)
	}

	vm_cpu_exit(page.vm)

	if ended, end := page_ended(page); ended {
		page_fail(page, end)
	}

	defer if allocated {
		delete(raw)
	}

	switch {
	case strings.has_prefix(raw, "ok:"):
		return .Resolved, strings.clone(raw[len("ok:"):], job.allocator)
	case strings.has_prefix(raw, "error:"):
		return .Rejected, strings.clone(raw[len("error:"):], job.allocator)
	case exception != nil:
		return .Rejected, strings.clone("the script's probe threw", job.allocator)
	}

	return .Pending, ""
}
