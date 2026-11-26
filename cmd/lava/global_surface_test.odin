#+build linux, darwin
package main

import "core:strings"
import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Pins Global_Surface (runtime.odin), a Lava-only seam with no node counterpart:
// node has one global surface, so nothing here is oracle-able and it lives in an
// Odin test. `.Node` is the default and must stay byte-identical to the pre-seam
// runtime; `.Web` must make every Node-only NAME unreachable from the script while
// the web-platform APIs it keeps still WORK, not merely exist — an API that throws
// because an internal module read a removed global live would pass a `typeof`
// check and fail here.
//
// Every check is recorded and compared at the end rather than thrown at first
// failure, so a mutation's red output names the check it broke (the manifest's
// expect_detail matches on that name). The sync table throws from the top level
// (Execution_Error, message carries the names); the async table throws from a
// timer (an uncaught async exception: exit code 1, the names on stderr). A
// watchdog timer that only a completed async table clears keeps a chain that never
// settles from passing silently.
GLOBAL_SURFACE_WEB_SCRIPT :: `
const results = [];
function record(name, fn) {
  let out;
  try {
    out = String(fn());
  } catch (e) {
    out = 'THREW:' + e.name + ':' + e.message;
  }
  results[results.length] = name + '=' + out;
}
function compare(table, got, want) {
  const bad = [];
  for (let i = 0; i < want.length || i < got.length; i++) {
    if (got[i] !== want[i]) bad[bad.length] = 'want ' + want[i] + ' got ' + got[i];
  }
  if (bad.length !== 0) throw new Error(table + ': ' + bad.join('; '));
}

// The names, by typeof — 'in globalThis' would also pass for a name that is
// reachable through a scope binding rather than a global property.
record('process', function () { return typeof process; });
record('require', function () { return typeof require; });
record('module', function () { return typeof module; });
record('exports', function () { return typeof exports; });
record('__filename', function () { return typeof __filename; });
record('__dirname', function () { return typeof __dirname; });
record('Buffer', function () { return typeof Buffer; });
record('global', function () { return typeof global; });
record('setImmediate', function () { return typeof setImmediate; });
record('clearImmediate', function () { return typeof clearImmediate; });
record('__lava_precache', function () { return typeof __lava_precache; });
record('__lavaDrainNextTicks', function () { return typeof __lavaDrainNextTicks; });
record('__lava_tl_drain', function () { return typeof __lava_tl_drain; });
// Catches a __lava* hook this list does not name yet. Taken again from the async
// table, next to 'tl-drain-after': a statement appended to the entry (the top-level
// drain's 'var __lava_tl_drain = …') has only RUN once the body has finished, and
// JSC keeps that program-level var out of getOwnPropertyNames — the census misses
// it, while typeof and 'in' see it.
function lavaOwn() {
  const names = Object.getOwnPropertyNames(globalThis);
  const hits = [];
  for (let i = 0; i < names.length; i++) if (names[i].slice(0, 6) === '__lava') hits[hits.length] = names[i];
  return hits.length === 0 ? 'none' : hits.join(',');
}
record('lava-own', lavaOwn);
// A fresh function body resolves free names against the global object only.
record('fn-process', function () { return new Function('return typeof process')(); });

// The kept APIs, exercised.
record('url', function () {
  const u = new URL('https://a.example/p?x=1&y=2');
  u.searchParams.append('z', '3');
  return u.href + '|' + u.searchParams.get('y');
});
record('text', function () {
  const s = 'héllo € 😀';
  const bytes = new TextEncoder().encode(s);
  return bytes.length + ':' + (new TextDecoder().decode(bytes) === s);
});
record('clone', function () {
  const inner = { v: 1 };
  const src = { a: { b: [1, 2] }, m: new Map([['k', inner]]) };
  const c = structuredClone(src);
  return [c !== src, c.a !== src.a, c.a.b.join('-'), c.m instanceof Map, c.m.get('k').v, c.m.get('k') !== inner].join(',');
});
record('headers', function () {
  const h = new Headers({ 'Content-Type': 'text/plain' });
  h.append('X-A', '1');
  h.append('x-a', '2');
  return h.get('content-type') + '|' + h.get('x-a');
});
record('base64', function () { return btoa('hi?') + '|' + atob('aGk/'); });
record('crypto', function () {
  const a = new Uint8Array(16);
  const r = crypto.getRandomValues(a);
  const id = crypto.randomUUID();
  return [/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id), r === a, a.length].join(',');
});
record('abort', function () {
  const ac = new AbortController();
  let fired = 0;
  ac.signal.addEventListener('abort', function () { fired++; });
  ac.abort();
  return [fired, ac.signal.aborted, ac.signal.reason.name].join(',');
});
record('performance', function () {
  const a = performance.now();
  return typeof a === 'number' && a >= 0 && performance.now() >= a;
});
record('stream-family', function () {
  return [ReadableStream, WritableStream, TransformStream, ByteLengthQueuingStrategy, CountQueuingStrategy,
    fetch, Request, Response, Blob, File].map(function (f) { return typeof f; }).join(',');
});
record('console', function () { return console.log('global-surface web ok'); });

compare('sync', results, [
  'process=undefined', 'require=undefined', 'module=undefined', 'exports=undefined',
  '__filename=undefined', '__dirname=undefined', 'Buffer=undefined', 'global=undefined',
  'setImmediate=undefined', 'clearImmediate=undefined', '__lava_precache=undefined',
  '__lavaDrainNextTicks=undefined', '__lava_tl_drain=undefined', 'lava-own=none', 'fn-process=undefined',
  'url=https://a.example/p?x=1&y=2&z=3|2', 'text=15:true', 'clone=true,true,1-2,true,1,true',
  'headers=text/plain|1, 2', 'base64=aGk/|hi?', 'crypto=true,true,16', 'abort=1,true,AbortError',
  'performance=true',
  'stream-family=function,function,function,function,function,function,function,function,function,function',
  'console=undefined',
]);

// Async: registered in this order at the top level, so the microtask order is
// observable — queueMicrotask shares one FIFO with promise jobs.
const order = [];
queueMicrotask(function () { order[order.length] = 'qm'; });
Promise.resolve().then(function () { order[order.length] = 'p'; });

const watchdog = setTimeout(function () {
  throw new Error('async: never completed');
}, 5000);
const cancelled = setTimeout(function () {
  throw new Error('async: a cleared timeout fired');
}, 1);
clearTimeout(cancelled);

const asyncResults = [];
async function arecord(name, fn) {
  let out;
  try {
    out = String(await fn());
  } catch (e) {
    out = 'THREW:' + e.name + ':' + e.message;
  }
  asyncResults[asyncResults.length] = name + '=' + out;
}

async function main() {
  // main() runs synchronously up to its first await; yield a timer turn first so the
  // top-level microtasks above have run when 'microtask-order' reads them.
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  await arecord('microtask-order', function () { return order.join(','); });
  await arecord('lava-own-after', lavaOwn);
  await arecord('tl-drain-after', function () {
    return typeof __lava_tl_drain + ',' + ('__lava_tl_drain' in globalThis);
  });
  await arecord('stream', async function () {
    const rs = new ReadableStream({
      start(c) { c.enqueue('a'); c.enqueue('b'); c.close(); },
    });
    const reader = rs.getReader();
    let s = '';
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      s += r.value;
    }
    return s;
  });
  await arecord('blob', function () { return new Blob(['x', 'y']).text(); });
  await arecord('response', function () { return new Response('x').text(); });
  await arecord('timeout', function () {
    return new Promise(function (resolve) { setTimeout(resolve, 1, 'fired'); });
  });
  await arecord('interval', function () {
    return new Promise(function (resolve) {
      let n = 0;
      const id = setInterval(function () {
        n++;
        if (n === 3) {
          clearInterval(id);
          // One more tick past the clear: a live interval would push n to 4.
          setTimeout(function () { resolve(n); }, 5);
        }
      }, 1);
    });
  });
}
main().then(function () {
  clearTimeout(watchdog);
  setTimeout(function () {
    compare('async', asyncResults, [
      'microtask-order=qm,p', 'lava-own-after=none',
      'tl-drain-after=undefined,false', 'stream=ab', 'blob=xy', 'response=x', 'timeout=fired', 'interval=3',
    ]);
  }, 0);
});
`

@(test)
global_surface_web_hides_node_names :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(GLOBAL_SURFACE_WEB_SCRIPT, "<global-surface-web-test>", &loop, false, surface = .Web)
	defer lava.result_destroy(&result)

	testing.expectf(
		t,
		result.status == .Ok,
		"eval did not complete cleanly: status=%v message=%q",
		result.status,
		result.message,
	)
	// Non-zero means the async table threw from its timer (its names are on stderr)
	// or the watchdog fired.
	testing.expectf(t, result.exit_code == 0, "eval exit code=%d (want 0)", result.exit_code)
}

// The ESM transform emits `require` and `__lava_precache`, which `.Web` never
// injects, so an `.mjs` source name is refused up front rather than failing inside
// the transformed body. The `.Node` control proves the refusal is the surface's.
@(test)
global_surface_web_rejects_mjs :: proc(t: ^testing.T) {
	web := lava.eval("export const x = 1;\n", "entry.mjs", nil, surface = .Web)
	defer lava.result_destroy(&web)
	testing.expectf(t, web.status == .Invalid_Input, "web .mjs status=%v (want Invalid_Input)", web.status)
	testing.expect_value(t, web.exit_code, 2)
	testing.expectf(t, strings.contains(web.message, ".mjs"), "web .mjs message=%q", web.message)

	node := lava.eval("export const x = 1;\n", "entry.mjs", nil)
	defer lava.result_destroy(&node)
	testing.expectf(t, node.status == .Ok, "node .mjs status=%v message=%q", node.status, node.message)
}

// What each surface's script asserts about the names. Thrown from the top level, so
// a miss lands in Result.message by name.
@(private = "file")
NODE_NAMES_PRESENT :: `
const missing = ['process', 'require', 'module', 'exports', '__filename', '__dirname', 'Buffer', 'global',
  'setImmediate', 'clearImmediate', '__lava_precache', '__lavaDrainNextTicks'].filter(function (n) {
  return new Function('return typeof ' + n)() === 'undefined';
});
if (missing.length !== 0) throw new Error('node surface missing: ' + missing.join(','));
`

@(private = "file")
NODE_NAMES_ABSENT :: `
const present = ['process', 'require', 'module', 'exports', '__filename', '__dirname', 'Buffer', 'global',
  'setImmediate', 'clearImmediate', '__lava_precache', '__lavaDrainNextTicks', '__lava_tl_drain'].filter(function (n) {
  return new Function('return typeof ' + n)() !== 'undefined';
});
if (present.length !== 0) throw new Error('web surface still has: ' + present.join(','));
`

// Node → Web → Node on one thread: nothing the first context set up (a cached host
// function, a thread-local) may carry the Node names into the Web one, and the Web
// one must not leave the next Node context short. The Node evals use the DEFAULT
// argument, which pins `.Node` as the default surface.
@(test)
global_surface_alternates_on_one_thread :: proc(t: ^testing.T) {
	expect_ok :: proc(t: ^testing.T, what: string, result: lava.Result) {
		testing.expectf(t, result.status == .Ok, "%s: status=%v message=%q", what, result.status, result.message)
	}

	first := lava.eval(NODE_NAMES_PRESENT, "<surface-node-1>", nil)
	defer lava.result_destroy(&first)
	expect_ok(t, "node before web", first)

	web := lava.eval(NODE_NAMES_ABSENT, "<surface-web>", nil, surface = .Web)
	defer lava.result_destroy(&web)
	expect_ok(t, "web after node", web)

	second := lava.eval(NODE_NAMES_PRESENT, "<surface-node-2>", nil)
	defer lava.result_destroy(&second)
	expect_ok(t, "node after web", second)
}

// `.Web` never runs install_stdio, so internal/stdio and the node-streams stack it
// pulls in (node:stream, events, the internal/streams/* files) are never compiled.
// Observed through Runtime_State.builtin_compiles, the counter lazy_builtins_test.odin
// reads: after init, the first `events` resolve compiles it under `.Web` and finds it
// cached under `.Node`. `events` rather than `stream` because only stdio's stack pulls
// it in and its factory reads no removed global; node:stream's internals capture
// `process.nextTick` at module-eval, so instantiating it on `.Web` throws — which is
// fine, nothing there can require it. Built by hand rather than through lava.eval so
// the state outlives init and the counter can be read.
@(test)
global_surface_web_skips_stdio :: proc(t: ^testing.T) {
	node_init, node_events, node_ok := surface_resolve_compiles(.Node, "events")
	web_init, web_events, web_ok := surface_resolve_compiles(.Web, "events")
	testing.expect(t, node_ok, "node: the builtin resolver did not answer 'events'")
	testing.expect(t, web_ok, "web: the builtin resolver did not answer 'events'")

	testing.expectf(
		t,
		node_events == 0,
		"node: resolving events compiled %d factories (want 0: stdio loaded it)",
		node_events,
	)
	testing.expectf(t, web_events > 0, "web: resolving events compiled nothing — stdio was instantiated at init")
	testing.expectf(
		t,
		web_init < node_init,
		"web init compiled %d factories, node init %d — web must compile fewer",
		web_init,
		node_init,
	)
}

// `.Web` installs every web global — Blob/File/atob/btoa and the URL object-URL statics,
// the Web Streams family, URL/URLSearchParams, crypto — from internal/ modules, without
// instantiating a js/node/ module beyond WEB_NODE_MODULES. The Node-profile removal
// deletes js/node/ (docs/LARVA.md decision 1), and a web global whose installer still
// lived in a node/ module would go with it. Lava-only: which factories init ran is
// not observable from a page or from node.
//
// Read per module through Runtime_State.builtin_compiles on a FRESH `.Web` context:
// resolving an id the loader already instantiated compiles nothing, resolving one it
// did not compiles at least that factory. Fresh per id because a resolve instantiates
// the module's own requires too, which would read as "loaded at init" for the next id
// probed on the same context.
@(test)
global_surface_web_loads_no_node_module :: proc(t: ^testing.T) {
	probed := 0

	for dir in lava.EMBEDDED_JS_DIRS {
		if dir.prefix != "node" && !strings.has_prefix(dir.prefix, "node/") {
			continue
		}

		for file in dir.files {
			if !strings.has_suffix(file.name, ".js") {
				continue
			}

			// Not the temp allocator: surface_resolve_compiles frees it on return.
			id := strings.concatenate({dir.prefix, "/", file.name[:len(file.name) - len(".js")]})
			defer delete(id)
			_, compiles, answered := surface_resolve_compiles(.Web, id[len("node/"):])
			loaded := answered && compiles == 0
			allowed := false

			for keep in WEB_NODE_MODULES {
				if keep == id {
					allowed = true
				}
			}

			probed += 1

			if allowed {
				testing.expectf(t, loaded, "%s is in WEB_NODE_MODULES but .Web init no longer loads it: drop it", id)
			} else {
				testing.expectf(t, !loaded, "%s was loaded by .Web init", id)
			}
		}
	}

	testing.expectf(t, probed > len(WEB_NODE_MODULES), "probed %d node/ modules — the embedded table is empty", probed)
}

// The node/ modules `.Web` init still instantiates, and why. Must only shrink.
//   node/buffer  The loader instantiates it unconditionally, and shared Web API code is
//                still Buffer-backed: internal/crypto/random and crypto/util, base64
//                (atob/btoa), blob and structured_clone through the loader's
//                pristineBuffer, and the streams under fetch. internal/encoding no
//                longer is (S4b); stages S4c-S4d take Buffer out of the rest.
@(private = "file")
WEB_NODE_MODULES :: [?]string{"node/buffer"}

// surface_resolve_compiles inits a context on `surface` and returns how many builtin
// factories init compiled, then how many one resolve of `spec` compiled on top, and
// whether the resolver answered it with exports (false for an unknown or excluded id
// and for a factory that threw).
@(private = "file")
surface_resolve_compiles :: proc(
	surface: lava.Global_Surface,
	spec: string,
) -> (
	at_init: int,
	compiles: int,
	answered: bool,
) {
	jsc.lava_jsc_init()
	gclass := lava.make_global_class()
	gctx := jsc.JSGlobalContextCreate(gclass)

	if gctx == nil {
		jsc.JSClassRelease(gclass)
		return
	}

	defer jsc.JSClassRelease(gclass)
	defer jsc.JSGlobalContextRelease(gctx)
	ctx := cast(jsc.JSContextRef)gctx

	state := lava.new_runtime_state(nil)
	jsc.JSObjectSetPrivate(jsc.JSContextGetGlobalObject(ctx), cast(rawptr)state)
	defer lava.destroy_runtime_state(ctx, state)
	lava.capture_error_intrinsics(ctx, state)
	jsc.prime_view_probe(ctx)
	lava.setup_module_environment(ctx, "<global-surface-resolve-test>", nil, surface)
	defer free_all(context.temp_allocator)

	at_init = state.builtin_compiles
	exception: jsc.JSValueRef
	exports := lava.require_builtin(ctx, lava.js_string_value(ctx, spec), &exception)
	answered = exports != nil
	compiles = state.builtin_compiles - at_init
	return
}
