#+build linux, darwin
package main

import "core:strings"
import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Pins the Window global surface (docs/LARVA.md decision 1): every Node-only NAME is
// unreachable from the page while the web-platform APIs still WORK, not merely exist —
// an API that throws because an internal module read a removed global live would pass
// a `typeof` check and fail here. tests/web/cases/globals-window.js pins the names
// against Chrome; this adds the internal `__lava*` hooks Chrome cannot know about.
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
	result := lava.eval(GLOBAL_SURFACE_WEB_SCRIPT, "<global-surface-web-test>", &loop, false)
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

// A page runs classic scripts only, so an `.mjs` source name is refused up front.
@(test)
global_surface_web_rejects_mjs :: proc(t: ^testing.T) {
	web := lava.eval("export const x = 1;\n", "entry.mjs", nil)
	defer lava.result_destroy(&web)
	testing.expectf(t, web.status == .Invalid_Input, "web .mjs status=%v (want Invalid_Input)", web.status)
	testing.expect_value(t, web.exit_code, 2)
	testing.expectf(t, strings.contains(web.message, ".mjs"), "web .mjs message=%q", web.message)
}

