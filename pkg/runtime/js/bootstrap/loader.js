// Internal built-in module loader. Given a native `compile(id)` that evaluates a
// module's embedded source to its factory `(require, module, exports, native) =>
// exports?` (undefined when the id is not a builtin), it instantiates the modules that
// install the Window globals and hands every factory a `require` over the same table
// (with the usual CommonJS partial-exports behavior on cycles). Nothing here is
// reachable from page code: a page has no `require` (docs/LARVA.md decision 1).
//
// A factory is compiled on its module's first require, not at context init, so a
// page pays only for the eager closure below plus what it touches lazily
// (the req() calls below are the current list; scripts/lib/js-graph.mjs reads them).
// `compile` stays in this closure and the cache below keeps it to one call per module.
//
// A module id is its path under pkg/runtime/js without `.js` — `internal/primordials`,
// `internal/fetch/body`.
//
// `neverOptimize(...fns)` is a native that keeps JSC's optimizing JIT off the functions
// it is given (pkg/jsc/private_optimize.odin); a no-op on a JSC without the hook.
(function (compile, natives, neverOptimize) {
  'use strict';

  var cache = Object.create(null);
  natives = natives || Object.create(null);

  function load(id) {
    if (id in cache) return cache[id];
    // Native and exact: compile matches the id against the embedded file table, so
    // a polluted prototype key yields undefined instead of an inherited function.
    // Nothing is cached for an unknown id.
    var factory = compile(id);
    if (factory === undefined) return;
    var module = { exports: {} };
    // Seed the cache before running the factory so a require cycle resolves
    // to the partially-built exports object instead of looping forever.
    cache[id] = module.exports;
    // natives[id] (or undefined) carries any Odin-backed primitives for this
    // module — e.g. crypto's CSPRNG.
    var result = factory(req, module, module.exports, natives[id]);
    cache[id] = result !== undefined ? result : module.exports;
    return cache[id];
  }

  function req(id) {
    return load(id);
  }

  // Install-time code runs once per page but calls its helpers once per module or per
  // interface member, often enough that JSC compiled each of them with the DFG on every
  // page: work a JIT thread did for code that never runs again, since a page's
  // functions die with it. So the loader's own two, and the helpers an internal module
  // hands to req.neverOptimize (internal/native_shape's), stay in the baseline tier.
  // Only install-time helpers: the wrappers a page calls keep every tier.
  if (typeof neverOptimize !== 'function') neverOptimize = function () {};
  neverOptimize(load, req);
  req.neverOptimize = neverOptimize;

  // Eagerly instantiate modules that install globals (Blob/File/atob/btoa and the URL
  // object-URL statics; the Web Streams ReadableStream/WritableStream/TransformStream
  // family; fetch/Response/Headers/Request; crypto's WHATWG global; URL/URLSearchParams),
  // so they are present before page code runs. Each web global is installed by the
  // internal/ module that defines it, at its module-eval. internal/webstreams/index runs before `fetch` because fetch
  // builds response bodies from the public ReadableStream. internal/url runs after
  // internal/blob (so it preserves the URL.createObjectURL/revokeObjectURL statics
  // blob attaches) and after `encoding` (which installs the TextEncoder/TextDecoder
  // globals url uses); url also lazily creates its codecs, so the order is
  // belt-and-suspenders rather than load-bearing.
  // primordials is eager-loaded FIRST, before any other internal module and well
  // before user code, so it captures pristine intrinsics (see primordials.js).
  // Other modules require('internal/primordials') and get this cached, pristine table.
  //
  // Then lock Function.prototype.call/apply/bind (#450) and make them plus every method
  // a primordials wrapper holds non-extensible (#494; the deviation is documented on
  // lockIntrinsics). Here and nowhere else, for two reasons. It must follow the capture,
  // which reads the three as plain values. And the loader is the one choke point every
  // page entry runs behind: install_globals runs this loader before the page's script.
  // Only runtime code runs before this line (the console prelude), so locking here
  // leaves no window.
  req('internal/primordials').lockIntrinsics();
  // Function.prototype.toString's mask and the helper every Web API global is defined
  // through (#114): before the first module that installs one, and before user code.
  req('internal/native_shape');
  // bootstrap/console.js ran before this loader and has no `require`, so its namespace is
  // shaped here, still before user code, with context/createTask/memory added
  // (internal/console).
  req('internal/console');
  // FinalizationRegistry cleanups and WebAssembly settlements back onto the page's own
  // loop (#91, #97). Before any module that could allocate a registry, and before user
  // code, which must only ever see the wrapped constructors.
  req('internal/deferred');

  // Named here because they install the Blob/File/atob/btoa globals and the URL statics.
  req('internal/blob');
  req('internal/file');
  // FormData, whose entries hold Files.
  req('internal/formdata');
  req('internal/base64');
  req('internal/webstreams/index');
  req('internal/fetch');
  // DOMException/QuotaExceededError: required by internal/abort at its top level, named
  // here because it installs the two globals.
  req('internal/domexception');
  // EventTarget/Event/CustomEvent, which AbortSignal derives from.
  req('internal/event_target');
  req('internal/abort');
  req('internal/encoding');
  req('internal/url');
  req('internal/structured_clone');
  // The `performance` global: a Performance EventTarget whose User Timing marks clone
  // their `detail` through structured_clone, so after both.
  req('internal/performance');
  // `location`/`history` (the page URL and its session history) and `navigator`/`screen`
  // with the window's geometry (the client profile). History's state is a structured
  // clone, so after structured_clone; Screen is an EventTarget.
  req('internal/location');
  req('internal/navigator');
  // matchMedia over the profile's viewport, and the Intersection/ResizeObservers over
  // internal/layout's estimate (which internal/navigator instantiated, with the viewport).
  req('internal/media');
  req('internal/observers');
  // The page's side of the cookie jar, which fetch(), XMLHttpRequest and document.cookie
  // reach lazily: it parses URLs, so after internal/url (and TextEncoder before it).
  req('internal/cookie');
  // Storage and the localStorage/sessionStorage attributes; its quota error is a
  // QuotaExceededError, so after internal/domexception.
  req('internal/storage');
  // XMLHttpRequest, its upload and event-target interfaces, and ProgressEvent: over
  // fetch's transport, with events from internal/event_target, so after both.
  req('internal/xhr');

  // internal/crypto/random installs the WHATWG `crypto` global at its module-eval.
  // internal/blob mints object-URL ids with crypto.randomUUID, but it is instantiated
  // above, before crypto exists, so it gets the function through the internal-req
  // channel, read here, still before page code: a replaced
  // `globalThis.crypto.randomUUID` does not pick the id.
  req.pristineRandomUUID = req('internal/crypto/random').randomUUID;

  // The loader's handle, kept by Odin on Runtime_State (never reached by page code).
  // bootstrap/microtasks.js defines queueMicrotask through internal/native_shape, and
  // has no `require`: install_microtasks reads it off this handle, so it is shaped as
  // every other Web API global (#114).
  //
  // installDom is the page loader's (pkg/runtime/dom.odin dom_install): an HTML page's
  // DOM, required on first use rather than here, so a page with no document — every
  // `lava run` page — never compiles internal/dom. Called before the page's first script.
  return Object.freeze({
    __proto__: null,
    nativeShape: req('internal/native_shape'),
    installDom: function (native, names) {
      return req('internal/dom').install(native, names);
    },
  });
});
