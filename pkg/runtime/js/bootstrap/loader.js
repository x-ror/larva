// Internal built-in module loader. Given a native `compile(id)` that evaluates a
// module's embedded source to its factory `(require, module, exports, native) =>
// exports?` (undefined when the id is not a builtin), it returns a `require`
// implementation that instantiates each module lazily, caches it, strips the
// `node:` prefix, and lets internal modules require one another (with the usual
// CommonJS partial-exports behavior on cycles). The resolver is what native
// `require()` consults before touching the filesystem.
//
// A factory is compiled on its module's first require, not at context init, so a
// script pays only for the eager closure below (13 of 39 files when this landed;
// cmd/lava/lazy_builtins_test.odin's STATIC_EAGER is the current list): `lava run
// bench/micro/noop.js` went 16.85 -> 14.63 ms (medians of 50 interleaved
// spawn-to-exit runs per arm after 5 warmups, darwin arm64, -o:speed, f106ab4 vs
// this change; see install_internal_modules).
// `compile` stays in this closure — never on `req`, `publicReq` or anything user
// code reaches — and the cache below is what keeps it to one call per module.
//
// A module id is its path under pkg/runtime/js without `.js` — `node/buffer`,
// `node/stream/web`, `internal/primordials` — so the DIRECTORY decides visibility:
// the public resolver answers `node/` ids only, and everything under `internal/`
// is reachable solely through the `require` handed to the factories.
(function (compile, natives) {
  'use strict';

  var cache = Object.create(null);
  natives = natives || Object.create(null);
  // node:http's implementation is split across js/internal/http/ (laid out like node's
  // _http_* files); the two that call into Odin take node:http's OWN bindings object as
  // their fourth argument, exactly as http.js did before the split — aliased here, not a
  // second binding set, so there is one parseRequest per context. node/http.js checks
  // the bindings before requiring either file.
  natives['internal/http/outgoing'] = natives['node/http'];
  natives['internal/http/server'] = natives['node/http'];

  // Prefix test by code unit. The specifier comes from user code on the public path,
  // so a String.prototype method here would be a live, replaceable read deciding
  // whether an internal module is handed out.
  function hasPrefix(s, prefix) {
    if (s.length < prefix.length) return false;
    for (var i = 0; i < prefix.length; i++) {
      if (s[i] !== prefix[i]) return false;
    }
    return true;
  }

  // Specifier -> module id. `internal/x` names the internal module; anything else is
  // a public builtin under `node/`. A specifier that already reads `node/buffer`
  // becomes `node/node/buffer` and resolves to nothing, so the id is not a second
  // public spelling.
  function toId(name) {
    var key = name.indexOf('node:') === 0 ? name.slice(5) : name;
    // assert/strict shares assert's (already strict) implementation.
    if (key === 'assert/strict') key = 'assert';
    return hasPrefix(key, 'internal/') ? key : 'node/' + key;
  }

  function load(id) {
    if (id in cache) return cache[id];
    // Native and exact: compile matches the id against the embedded file table, so
    // 'node/constructor' or a polluted prototype key yields undefined — the "not a
    // builtin" that lets native_require_cb fall through — instead of an inherited
    // function. Nothing is cached for an unknown id.
    var factory = compile(id);
    if (factory === undefined) return;
    var module = { exports: {} };
    // Seed the cache before running the factory so a require cycle resolves
    // to the partially-built exports object instead of looping forever.
    cache[id] = module.exports;
    // natives[id] (or undefined) carries any Odin-backed primitives for this
    // module — e.g. crypto's CSPRNG and one-shot hash/hmac/pbkdf2.
    var result = factory(req, module, module.exports, natives[id]);
    cache[id] = result !== undefined ? result : module.exports;
    return cache[id];
  }

  function req(name) {
    return load(toId(name));
  }

  // Eagerly instantiate modules that install globals (Buffer; the Web Streams
  // ReadableStream/WritableStream/TransformStream family; fetch/Response/Headers/
  // Request; crypto's WHATWG global; URL/URLSearchParams), so they are present
  // even when user code never requires them explicitly. `stream/web` runs before
  // `fetch` because fetch builds response bodies from the public ReadableStream.
  // `url` runs after `buffer` (so it preserves the URL.createObjectURL/
  // revokeObjectURL statics buffer attaches) and after `encoding` (which installs
  // the TextEncoder/TextDecoder globals url uses); url also lazily creates its
  // codecs, so the order is belt-and-suspenders rather than load-bearing.
  // primordials is eager-loaded FIRST, before any other internal module and well
  // before user code, so it captures pristine intrinsics (see primordials.js).
  // Other modules require('internal/primordials') and get this cached, pristine table.
  req('internal/primordials');
  req('buffer');

  // Hand the LAZY internal modules a PRISTINE Buffer.
  //
  // §5's "capture at module-eval" rule is sound only for modules the LOADER instantiates
  // before user code. A lazy module's factory does not run until user code calls require()
  // for it, so its own `require('buffer').Buffer` reads whatever the exports object holds
  // by then — the object user code holds.
  //
  // WHAT NODE ACTUALLY DOES, because an earlier version of this comment got it backwards.
  // Node does NOT route payload bytes through the public `Buffer.from`, so replacing that
  // member cannot corrupt node's output — measured, `sock.write('PAYLOAD')` delivers
  // "PAYLOAD" on node and delivered "TAMPERED" here. That specific divergence is what this
  // table closes. Node IS steerable through the same export for other members: with
  // `Buffer.byteLength` returning real+3, node answered `Content-Length: 10` for a 7-byte
  // body. So "node uses the buffer binding and is immune" is false and must not be
  // repeated — Lava is deliberately STRICTER than node here, which §1 counts as a
  // deviation and `65-lazy-buffer-capture.js` pins on the vectors it can express.
  //
  // Three categories, and only the third needs this table:
  //   eager (the list above)         — their own capture is pristine
  //   bootstrap (stream, stdio)      — instantiated by installStdio before user code
  //   lazy (fs, http, https, net, os) — capture at the user's first require(): TOO LATE
  //
  // The OPERATIONS, not just the constructor: `.from` is read off the constructor at CALL
  // time, so `Buffer.from = evil` steers a module holding a pristine `Buffer`. Same lesson
  // as `Symbol.for` in util.js — the object is not the method.
  //
  // Attached to the internal `req`, so a module reads `require.pristineBuffer` with no new
  // factory argument. The shape mirrors `publicReq.primordials` below, though that one
  // hangs off the PUBLIC resolver and is read by Odin for esm.js, not by a factory — this
  // is the first use of the internal-req channel, not a reuse of an existing one.
  var PristineBufferCtor = req('buffer').Buffer;
  req.pristineBuffer = {
    __proto__: null,
    Buffer: PristineBufferCtor,
    from: PristineBufferCtor.from,
    alloc: PristineBufferCtor.alloc,
    concat: PristineBufferCtor.concat,
    isBuffer: PristineBufferCtor.isBuffer,
    isEncoding: PristineBufferCtor.isEncoding,
    // Already UNCURRIED, so a consumer calls `bufferToString(buf, 'utf8')` directly. The
    // primordials table sets this convention (`ArrayPrototypeSlice: caller2(...)`) — a raw
    // unbound method invites each consumer to re-derive it, and two consumers deriving it
    // differently is how the six copies of describeType happened.
    bufferToString: req('internal/primordials').uncurryThis(PristineBufferCtor.prototype.toString),
    // The rest of the framing path in http.js's chunked decoder: it reads the chunk-size
    // line, finds the CRLF boundary and advances the cursor through these three. Every one
    // was a live `Buffer.prototype` read, i.e. a request-smuggling gadget — a replaced
    // `toString` that INFLATES the size is the sharp version. Node frames HTTP in C
    // (llhttp) and is not steerable here at all.
    bufferIndexOf: req('internal/primordials').uncurryThis(PristineBufferCtor.prototype.indexOf),
    bufferSlice: req('internal/primordials').uncurryThis(PristineBufferCtor.prototype.slice),
  };

  req('stream/web');
  req('internal/fetch');
  req('internal/abort');
  req('internal/encoding');
  req('url');
  req('internal/structured_clone');

  // crypto's ONE eager root (a second top-level req('crypto') would keep it eager even if
  // this one moved, which is what the lazy_builtins mutation relies on not happening).
  // internal/blob mints `blob:nodedata:` ids with crypto.randomUUID, but it is
  // instantiated by `buffer` above — before crypto exists — and cannot require crypto
  // back (crypto requires buffer at its top level: a cycle check-js-graph rejects). So it
  // gets the function through the same internal-req channel as pristineBuffer, read here,
  // still before user code: a replaced `globalThis.crypto.randomUUID` or
  // `require('crypto').randomUUID` no longer picks the id. Node mints it from its own
  // binding and is immune; pinned by tests/node-compat/cases/78-blob-pristine-reads.js.
  req.pristineRandomUUID = req('crypto').randomUUID;

  // The public resolver: what native require() consults. It answers `node/` ids only,
  // so nothing under internal/ is reachable from user code, for two reasons a module
  // lives there:
  //   1. It has no Node builtin at all — require('node:primordials') is
  //      ERR_UNKNOWN_BUILTIN_MODULE; util.parseArgs / util.MIMEType are the public
  //      surfaces for parse_args / mime.
  //   2. Its user-facing API is a GLOBAL, not a module — fetch, AbortController,
  //      TextEncoder/TextDecoder, and structuredClone are installed on globalThis
  //      by the eager loads above. `encoding` in particular is a real npm package
  //      (a transitive dep of node-fetch), so answering require('encoding') from
  //      here would shadow it and break the ecosystem. Not answering leaves the
  //      globals intact while letting the filesystem resolver find the package.
  // `require('fetch')` maps to `node/fetch`, which has no factory; `internal/fetch`
  // fails the prefix test below. Both return undefined and fall through to the
  // filesystem, never a shadow of an installed package.
  function publicReq(name) {
    var id = toId(name);
    if (!hasPrefix(id, 'node/')) return undefined;
    return load(id);
  }

  // The ESM source transform is the one internal module that cannot
  // require('internal/primordials'): the runtime evaluates js/bootstrap/esm.js standalone and
  // keeps the resulting function on Runtime_State, deliberately NOT registering it
  // as a requireable module (see globals.odin), so it never gets a `require`. It
  // still needs the pristine table — it emits executed source, so a live intrinsic
  // there is code injection, not a wrong answer.
  //
  // Hand the ALREADY-INSTANTIATED table out here rather than letting the runtime
  // evaluate primordials a second time, which would capture a parallel set and quietly
  // split the "captured once, before user code" guarantee in two.
  //
  // This is not a new user-visible surface: the resolver object never reaches user
  // code. What user code calls is the native require callback, which consults this
  // function through Runtime_State.builtin_require and returns only module exports.
  publicReq.primordials = req('internal/primordials');

  // stdio installs process.stdout/process.stderr. It cannot be eager-required here:
  // install_process runs before the loader (so natives['process'] can capture the
  // intrinsic for node:process — #247), but process.nextTick is installed only AFTER
  // the loader returns, and stdio/stream need nextTick. Exposed as a closure so
  // globals.odin can call it at the right moment, after microtasks are wired.
  publicReq.installStdio = function (proc) {
    req('internal/stdio').install(proc);
  };

  return publicReq;
});
