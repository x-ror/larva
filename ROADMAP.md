# Lava roadmap

Status of the Node.js port. Baseline target: Node 26+ on JavaScriptCore, with a
native event loop (kqueue / io_uring+epoll / IOCP).

## Done

The original runtime plan (PR #1) is complete:

- [x] **GC-protect bindings** — `JSValueProtect`/`JSValueUnprotect` so JS timer
      callbacks survive across loop turns (`pkg/jsc/bindings_*.odin`).
- [x] **Node global surface** — `console`, `process`
      (`argv`/`env`/`platform`/`version`/`pid`/`nextTick`/`exit`/`cwd`),
      `setTimeout`/`setInterval`/`setImmediate` + `clear*`, `queueMicrotask`,
      `globalThis` (`pkg/runtime/globals.odin`).
- [x] **Full `console` surface** — `log`/`info`/`debug`/`error`/`warn`,
      `dir`/`trace`/`assert`, `count`/`countReset`,
      `group`/`groupCollapsed`/`groupEnd`, `time`/`timeEnd`/`timeLog`,
      `table`, `clear`, `Console`, plus `util.format` (`%s/%d/%i/%f/%j/%o/%O/%c`)
      substitution and value inspection. Backed by two native write primitives;
      the rest is a JS prelude (`CONSOLE_PRELUDE` in `pkg/runtime/globals.odin`),
      matching Node's console output on the compat cases.
- [x] **CLI drives the loop** — `lava run`/`eval` create an `eventloop.Loop` and
      run it to idle (`cmd/lava/main.odin`).
- [x] **Loop pointer is private** — stored in the global object's private data
      (`LavaGlobal` JSClass), not a writable `__loop_ptr__` JS global.
- [x] **Module cache** — modules run once; `require` throws `MODULE_NOT_FOUND`
      instead of returning `undefined`.
- [x] **`fs.readFileSync`** returns a **`Buffer`** (no encoding) or a string (with
      encoding), decoded through Buffer's own codecs — see the `node:fs` JS layer entry
      below. This entry claimed completion for a year while returning a bare `Uint8Array`
      and ignoring the encoding argument outright.
- [x] **`fs.readFile`** (async callback form) — `(path[, options], cb)`, delivered
      on the event loop's poll phase via a new `queue_io_callback`, so the callback
      runs before a same-turn `setImmediate` (matches Node; passes the
      `08-io-before-immediate` oracle). The read itself is synchronous for now —
      not yet threadpool-backed — but the callback timing matches.
- [x] **Memory** — `free_all` the temp arena at the require boundary;
      single-allocation JS→string conversion.
- [x] **Windows support** — `pkg/jsc/bindings_windows.odin`
      (`system:JavaScriptCore.lib`), OS-aware path helpers; `select`-based
      event-loop backend.
- [x] **CI** — `.github/workflows/ci.yml`: full check/build/test on Linux
      (`javascriptcoregtk-6.0`) and macOS; on Windows, type-check + codegen, the
      event-loop tests, and a real JavaScriptCore-linked `lava.exe` runtime smoke
      (JSC provisioned from the Bun WebKit fork).

## Remaining

Tracked against the `tests/node-compat/cases` oracle. Every case in
`tests/node-compat/cases` now passes under Lava, including the ESM cases
(`01-esm`, `12-esm-features`); the ESM loader below has landed.

### Internal JS module layer (done in this batch)

Built-ins now live as embedded JS factories under `pkg/runtime/js/node/` (public,
path == specifier) and `pkg/runtime/js/internal/` (helpers only builtins reach),
wired by a small loader (`js/bootstrap/loader.js`) that native `require()` consults before
the filesystem (`require_builtin` in `globals.odin`). Minimal, original
implementations — a small internal `primordials` table for pollution hardening
(§5.5 of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)), no `internalBinding`
coupling.

- [x] **internal module loader** — lazy, cached, `node:`-prefix aware, eager for
      modules that install globals (Buffer, fetch).
- [x] **`util`** — `inspect` / `format` / `formatWithOptions`.
- [x] **`events` (EventEmitter)** + static `once` — _(passes `06-events`)_
- [x] **`node:assert`** real strict assertions (`AssertionError`, deep compare)
      — replaced the dangerous no-op.
- [x] **`Buffer` global** — `from`/`alloc`/`concat`/`copy`/`toString` over
      `Uint8Array`; utf8/hex/base64 codecs backed by Odin (`pkg/runtime/buffer.odin`,
      `core:encoding`) as the sole impl — _(passes `03-buffer`)_
- [x] **`node:crypto`** — `createHash`/`createHmac` (md5/sha1/sha2/sha3/blake2/sm3),
      `randomBytes`/`randomUUID`/`randomFill*`, `pbkdf2`/`pbkdf2Sync`, all backed
      by Odin `core:crypto` (`pkg/runtime/crypto.odin`) — _(passes `07-crypto`)_
- [x] **`fetch` / `Response` / `Headers` / `Request`** globals — body + headers
      machinery is real; the `http://` network transport is now Odin-backed
      (`pkg/runtime/fetch.odin`, `fetch_linux.odin`): non-blocking
      connect/write/read on the event-loop `IO_Watcher`, HTTP/1.1 request
      serialization, and response parsing (Content-Length + chunked). The promise
      is created in JS (`new Promise` + native success/error callbacks), so no
      `JSObjectMakeDeferredPromise` binding is needed. _(passes `08-fetch`;
      end-to-end node-parity via `make test-fetch-smoke`)_

### Architecture seams (five-subsystem review, 2026-07-27)

Local quality is high in every subsystem; the structural problems are at the
**seams** between them. Each of these is filed with its evidence — this list is
the index, the issue is the detail. Ordered by what it unblocks.

- [ ] **ESM is a source rewriter, not a loader**
      ([#345](https://github.com/x-ror/lava/issues/345) · epic) — no live bindings,
      no TLA (#65), no backing loader for `import()` (#64), no `"type": "module"`,
      no `"exports"`; CJS and ESM duplicate the wrapper contract in two languages.
- [ ] **HTTP framing is implemented twice with divergent limits**
      ([#343](https://github.com/x-ror/lava/issues/343)) — `fetch.odin` caps the head
      at 256 KiB, `http.js` at 64 KiB; chunk decoding exists in both. #226 is a
      symptom of the split.
- [ ] **No cross-thread work injection**
      ([#346](https://github.com/x-ror/lava/issues/346)) — `async_begin` is
      loop-thread-only, so no foreign thread can hand work to a loop. Blocks
      `worker_threads`.
- [ ] **The event-loop platform seam sits at the wrong altitude**
      ([#347](https://github.com/x-ror/lava/issues/347)) — readiness and proactor are
      coequal public APIs, the `Net_IO_Mode` ladder is pushed into consumers, and
      Linux-only ops (`submit_send_zc`) are package API.
- [ ] **`Runtime_State` is a god object**
      ([#344](https://github.com/x-ror/lava/issues/344)) — every subsystem is a
      field, init order is enforced by comments, and a bootstrap failure degrades
      silently into `MODULE_NOT_FOUND`.
- [ ] **`process.exit` calls `os.exit` from a `proc "c"`**
      ([#348](https://github.com/x-ror/lava/issues/348)) — no teardown, no flush, and
      in a multi-worker run it takes the siblings with it.
- [ ] **No scoped-borrow type for slices that alias the JSC heap**
      ([#350](https://github.com/x-ror/lava/issues/350)) — the GC-root half landed
      (`js_root.odin`); the borrow rule that the write-into natives already broke once
      is still review-only.
- [ ] **URL parsing is ~13x node and structurally so**
      ([#351](https://github.com/x-ror/lava/issues/351)) — the per-character WHATWG
      state machine runs in JS, on the `fetch` hot path; #310 took the easy 2.8x.
- [ ] **~22k lines of embedded JS are re-parsed per context**
      ([#349](https://github.com/x-ror/lava/issues/349)) — paid once per CLI run and
      N times per worker fleet; no snapshot or bytecode cache.
- [ ] **`ARCHITECTURE.md` is stale**
      ([#365](https://github.com/x-ror/lava/issues/365)) — §5.4 still lists `node:net`
      and `node:http` as future work, and CLAUDE.md points contributors there first.
- [ ] **The pure HTTP parsers cannot be unit-tested without JSC**
      ([#363](https://github.com/x-ror/lava/issues/363)) — extract to a
      `pkg/runtime/http` sub-package.
- [ ] **Bench harness hygiene**
      ([#364](https://github.com/x-ror/lava/issues/364)) — no RSS-over-time leak arm,
      no shared loadgen/warmup across runtimes, and MSG_ZEROCOPY never measured on a
      real NIC (loopback always copies).
- [ ] **`fs_mkdir_recursive` hand-rolls `core:os` `make_directory_all`**
      ([#366](https://github.com/x-ror/lava/issues/366)) — reuse-first violation.

### High priority (the Odin / native part)

- [x] **`fs.writeFileSync(path, dataView)` could write out-of-bounds heap into a
      caller-named file** — fixed. JSC's C API has no DataView byte accessor, so
      `fs_resolve_write_payload` reads `.byteOffset`/`.byteLength` off the object. Those
      are ordinary property reads, and on an object carrying its OWN accessors they run
      arbitrary JS — which can `resize()` the backing ArrayBuffer before returning. The
      resolver sampled the buffer's length BEFORE those reads and validated the window
      against that stale number, then took the base pointer after.
      Measured on a 4096-byte resizable buffer whose `byteOffset` getter calls
      `ab.resize(8)`: node writes 4096 bytes of the real buffer (its getters never run —
      internal slots), Lava wrote 4096 bytes over an 8-byte live allocation, so **4088
      bytes of adjacent heap landed in a file the script chose**. An arbitrary-length
      disclosure, not just a crash.
      The fix is ordering: read the claimed window first — the only step that can run user
      JS — then sample the authoritative length and take the pointer back to back, with
      only pure-Odin validation between them. Same family as the coercion re-entrancy in
      `cmd/lava/buffer_reentrancy_test.odin`, reached through a property read rather than
      a `valueOf`. Pinned by `cmd/lava/fs_write_payload_test.odin` plus a
      `tests/mutation-manifest.json` entry that restores the stale ordering.
- [ ] **A DataView's window is read from forgeable properties, not its internal slots**
      ([#242](https://github.com/x-ror/lava/issues/242)) —
      the residual half of the entry above, and a parity gap rather than a safety one.
      Node reads a DataView's `byteOffset`/`byteLength` from internal slots and ignores
      own accessors entirely; Lava reads the properties, so a forged pair selects a
      different window (and now rejects, where node writes the real bytes). `is_data_view`
      is the same shape — it compares `constructor.name` to `"DataView"`, which any object
      can claim. Neither is exploitable: every window that survives validation is in
      bounds of a buffer the caller already holds a reference to. Closing it needs the
      pristine `DataView.prototype` getters callable from native — a cached, protected
      `JSObjectRef` per context, swept from `destroy_runtime_state` like every other
      handle-keyed cache — which is a design decision of its own and was deliberately not
      bolted onto #326.
- [x] **`node:fs` had no JS layer, and three read bugs lived in the gap**
      ([#329](https://github.com/x-ror/lava/issues/329)) — fixed by adding
      `js/node/fs.js` over `make_fs_bindings`, so `node:fs` is no longer the
      native-direct outlier ARCHITECTURE.md §3.4 named. All three were pre-existing and
      none threw — each returned plausible-looking wrong output: 1. **Reads returned a bare `Uint8Array`, not a `Buffer`.** `Buffer.isBuffer` was
      false and `.toString('hex')` fell through to `Uint8Array.prototype.toString`,
      which ignores its argument: `"116,121"` where node gives `"7479"`. `.equals`,
      `.compare`, `.readUInt32BE`, `.toString('base64')` and `.indexOf(string)` were
      all wrong or missing on every file read. 2. **The encoding argument was ignored.** Every read decoded as UTF-8, so
      `readFileSync(p, 'hex')` returned the file's text instead of its hex. 3. **Undecodable bytes produced `""`.** Invalid UTF-8 yielded an empty string where
      node substitutes U+FFFD — the shape of bug that reads as an empty file.
      The layer fixes all three by never asking the native for a string: it takes bytes and
      decodes through `Buffer#toString`, reusing codecs the buffer oracle cases already
      cover instead of maintaining a second implementation. The re-tag is **zero copy**
      (`Buffer.from(arrayBuffer, byteOffset, length)` shares memory by spec), which matters
      because this is the hottest fs call there is. The other 13 primitives are re-exported
      by identity, so their `.name`, `.length` and object identity are unchanged.
      Encoding validation follows node's own shape, which took two passes to get right:
      every FALSY encoding means binary (node guards `if (encoding && ...)`, so `''`,
      `false`, `0` and `NaN` all return a Buffer — an earlier revision threw for them and
      broke code that worked before the layer existed), `'buffer'` is passed through
      validation so `Buffer#toString` rejects it with `ERR_UNKNOWN_ENCODING` rather than
      `ERR_INVALID_ARG_VALUE`, and `ERR_INVALID_ARG_TYPE` renders an object receiver as
      `an instance of <Ctor>` with strings over 28 chars cut to 25 plus `...`.
      `path` is type-checked too (a number is a file DESCRIPTOR on node, not a bad path),
      and the async error callback takes one argument as node's does.
      _Measured cost, and it is a regression:_ routing decoding through Buffer's codecs
      costs **1.31x at 1 KB, 2.72x at 100 KB, 1.34x at 10 MB** on `readFileSync(p,'utf8')`
      versus the old native conversion (medians of 7 interleaved launches per arm, both
      built with `scripts/build.sh`; a JSC sampling profile attributes 64.8% of the new
      wall time to the `utf8Decode` crossing that did not exist on this path). Binary reads
      are +5–6% at small sizes and 0.78x at 10 MB. That buys criterion 1 — the old path
      returned the wrong string for every non-UTF-8 encoding — but it is not free, and
      `bench/macro/fs.js` did not cover it. Recovering it means passing the VALIDATED
      encoding to the native and decoding from bytes with the in-tree Odin codecs.
      Pinned by `tests/node-compat/cases/62-fs-read-buffer.js` and
      `63-fs-buffer-capture.js` (both byte-identical to node) and thirteen
      `tests/mutation-manifest.json` entries.
- [x] **`util.inspect` did not quote a top-level string, and always used single quotes** —
      fixed alongside the fs layer, which needed correct rendering for node's error
      messages. `util.inspect('x')` returned `x` where node returns `'x'`: `inspect()`'s
      `depth === 0` branch exists to serve `format`/`console.log`, which print a string
      ARGUMENT raw, and the public entry was inheriting it (that branch is now deleted —
      `stringify` short-circuits strings before `inspect` is reached, so nothing else
      relied on it). The delimiter is now chosen node's way: double quotes when the string
      contains `'` but no `"`, backticks when it contains both AND neither a backtick nor
      `${`, single-with-escapes otherwise. The `${` guard is not cosmetic — inspect output
      is meant to read back as a literal, and a backtick-delimited `${` is a live template
      substitution; omitting it regressed output that was correct before.
      Pinned by `tests/node-compat/cases/57-format-single-arg.js` beside its
      "a lone string argument is returned VERBATIM" rules, because the fix for one is a
      plausible-looking break of the other, plus four mutation entries.
- [ ] **`fs` options and path forms that are accepted and ignored**
      ([#334](https://github.com/x-ror/lava/issues/334)) — `options.signal` and
      `options.flag` are taken and dropped, so a bad value returns a Buffer where node
      throws AND a real `AbortSignal` never aborts the read; a `file:` URL path is
      stringified rather than resolved (ENOENT where node reads); a NUMBER path is a file
      descriptor on node but reaches the native as the filename `"123"`. The last two are
      deliberately let through `validatePath` — rejecting them would be a worse divergence
      than the current one. Also: nothing asserts that `fs.js`'s `PASSTHROUGH` list still
      matches `make_fs_bindings`, so dropping or adding a native fails silently in both
      directions.
- [ ] **Coded errors omit `[CODE]` from `toString()`/`stack`**
      ([#335](https://github.com/x-ror/lava/issues/335)) — node renders
      `TypeError [ERR_INVALID_ARG_VALUE]: …` while keeping `name === 'TypeError'`; Lava
      renders `TypeError: …`. `err.code` is correct on both, so this only shows where an
      error is logged or stringified — which is most crash output. Repo-wide, not fs.
- [x] **`make bench-gate` is red on master**
      ([#336](https://github.com/x-ror/lava/issues/336)) — `urlsearchparams-get` sat at
      1.00x against a 0.9x cap after `url.js` primordials hardening (`118c8b5`, `5466d59`,
      `2f43897`); recalibrated alongside #362 (`bench/thresholds.json`) with headroom over
      both the 4-core `ubuntu-latest` CI runs and the unpinned dev-box median-of-3.
- [ ] **Encoded `fs` reads are 6.3x node** ([#332](https://github.com/x-ror/lava/issues/332))
      — the cost of moving decoding into `Buffer#toString`, measured above. Recovering it
      means passing the validated encoding to the native and decoding from bytes with the
      in-tree Odin codecs; correctness is already pinned by case 62, so that case going
      byte-identical is the acceptance test. Gated now by `fs-read-utf8-1k` /
      `fs-read-utf8-64k` / `fs-read-bin-1k`, which did not exist before.
- [x] **Lazy internal modules captured mutable module exports**
      ([#333](https://github.com/x-ror/lava/issues/333)) — fixed for the five LAZY modules.
      §5's "capture at module-eval" rule holds only for modules `loader.js` instantiates
      before user code; a lazy module's factory runs on the user's first `require()` of it,
      so its own `require('buffer').Buffer` reads whatever the exports object holds then —
      the object user code holds.
      _What node actually does, because the first version of this entry got it backwards:_
      node does **not** route payload bytes through the public `Buffer.from`, so replacing
      that member cannot corrupt node's output — `sock.write('PAYLOAD')` gives `"PAYLOAD"`
      on node and gave `"TAMPERED"` here. That divergence is what this closes. But node
      **is** steerable through the same export for other members: with `Buffer.byteLength`
      returning real+3, node answered `Content-Length: 10` for a 7-byte body. So Lava is
      deliberately STRICTER than node here — a §1 deviation, pinned on the vectors an
      oracle case can express.
      Three categories, and only the third needed the change: **eager** (the loader's list)
      capture pristinely; **bootstrap** (`stream`, `stdio`, via `installStdio`) likewise, so
      they keep their own capture; **lazy** (`fs`, `http`, `https`, `net`, `os`) capture too
      late. Capturing the CONSTRUCTOR is not enough either — `.from` is read off it at call
      time, so `Buffer.from = evil` steers a module holding a pristine `Buffer`; the loader
      snapshots the OPERATIONS.
      Two live `Buffer.prototype` reads found in the same pass and closed with it: `https`
      read the TLS key/cert PEM through `value.toString('utf8')` (a replacement returning a
      valid PEM makes the server present a chosen certificate), and `http`'s chunked decoder
      read the chunk size, the CRLF boundary and the cursor through live `toString`/
      `indexOf`/`slice` — request-smuggling gadgets over network-controlled bytes. Node
      frames HTTP in C and is not steerable in either.
      `os.userInfo` was rewritten to node's real contract while there: a **null-prototype**
      result, a case-insensitive encoding via `ParseEncoding` (`'BUFFER'` works), other
      known encodings **transcode** (`hex` → `"74796d6368"`), and an unrecognized one falls
      back to the plain string rather than throwing.
      Pinned by `tests/node-compat/cases/65-lazy-buffer-capture.js` — `net` in both
      directions, `os` at module-eval and call time, `http` response body and chunked
      framing — and eight mutation entries. Migrating to captured operations LOWERED the
      ratchet from 1590 to 1558.
- [ ] **`process.stdout`/`stderr` surface holes and the tty half**
      ([#328](https://github.com/x-ror/lava/issues/328)) — `constructor.name`, `pipe`
      (absent on every Writable, not just stdio — `stream.js` defines only
      `Readable.prototype.pipe`), `writableCorked`, `closed`, `errored`, `_writev`; the
      write-callback err arg (`undefined` where node passes `null`); `end(cb)` running
      after `'finish'` instead of before; a swallowed EPIPE where node dies noisily; and
      `columns`/`rows`/`getWindowSize`/`hasColors` on a terminal, which need TIOCGWINSZ.
- [ ] **`process.on` does not exist**
      ([#355](https://github.com/x-ror/lava/issues/355)) — so `process.on('exit', …)`
      throws; found while
      pinning the above, which had to use a timer instead. Also still missing:
      `process.hrtime` (`hrtime.bigint()` throws; `JSBigIntCreateWithUInt64` IS exported by
      the JSC we link, so the in-repo "no BigInt constructor" comment is stale), and
      `tty.js`'s `getWindowSize()` fakes 80x24 from env vars with no `TIOCGWINSZ` ioctl —
      `linux.ioctl` and `linux.TIOCGWINSZ` both exist in `core:sys/linux`; only the
      `winsize` struct needs declaring.
- [x] **`esm.js` — the module loader, and the one surface where a forged match is
      code execution** — done: 101 counted sites (method 81, global 20) to 0 in all
      four classes. This outranked the rest of the tail because the file's output is
      _executed source_: `export default function foo` lifts the declared name out of a
      match group and interpolates it into the emitted CommonJS as an identifier. A
      gadget steering only that one pattern — every other regex answering honestly, so
      the transform runs to completion — evaluated an attacker's expression at module
      scope. Demonstrated before the fix, not argued: `pwned=CODE INJECTED` under Lava
      where node printed `pwned=undefined`. Reachability is ordinary, since any CJS
      dependency required before the first `.mjs` can assign `RegExp.prototype.exec`.
      There were **no** global-flag regexes in the file, so the spin-forever class that
      `url.js`/`fetch.js` hit is genuinely absent here — this was injection, not DoS.
      The patterns became module-scope **literals** rather than captured-and-rebuilt
      `new RegExp(...)`: a literal consults no `RegExp` global, so it cannot be pointed
      at another constructor, and `.match`/`.test`/`.replace(re, …)` are all gone rather
      than captured, since each re-reads `R.exec` off the receiver.
      Two adjacent carriers came with it, both in the masking scanner that decides what
      counts as string versus code — and therefore which spans are eligible to be
      spliced out and re-emitted at all: 10 live `charAt` reads and two
      `Array.prototype.at` reads on the mode stack (`at(-1)` for the current frame,
      `at(-2)` for the `${}` close). The `charCodeAt` they moved onto is pinned too,
      because that is the same lesson `http.js` had already taught.
      It cannot `require('internal/primordials')` — the runtime evaluates it standalone and keeps
      it off the module table precisely so user code cannot reach the transform — so it
      takes the table as a factory argument, handed out by `loader.js` and passed in by
      `globals.odin`, which fails closed when it is missing.
      A **fourth carrier** was found by the merge gate after the first pass, and it was
      the cheapest of the set and invisible to the ratchet: `transformExport` carries an
      own `tail` on ONE of eight return shapes, so on the other seven `ex.tail` resolved
      off `Object.prototype` — and that value is joined into the emitted source. A
      data-only `{"__proto__":{"tail":["…"]}}` merge was therefore full code execution
      in the module body, needing no function value at all, i.e. strictly cheaper than
      the forged `exec` the pass was written for. `esm.js` read 0/0/0/0 in all four
      classes while it was open, because an absent-property read is none of the four —
      the sharpest instance yet of "the ratchet is a floor, not a proof". Closed with
      `__proto__: null` and an own `tail` on every branch. The same review found
      `INTERNAL_ONLY` in `loader.js` missing `__proto__: null` while being indexed by a
      caller-supplied specifier: `Object.prototype.http = true` made
      `require('node:http')` fall through to filesystem resolution — builtin denial, or
      a shadow where an npm package of that name exists.
      Pinned by `tests/node-compat/cases/58-esm-pollution.js` (eleven gadgets and an
      unpoisoned control) and twelve `tests/mutation-manifest.json` entries. That case
      is a **real differential**, not a Lava-only test: node's ESM loader is native C++
      and immune to every gadget, so node is the oracle and the case pins Node parity at
      the same time — the opposite conclusion from the one this file previously assumed
      for the loader.
      _Still open, deliberately:_ the value-copy deviation (named imports are not live
      bindings) has **no** pin. It cannot be an oracle case — the deviation _is_ the
      node-vs-Lava divergence, so any case exercising it fails `test-compat-lava` by
      construction — and the `@deviates` tag previously credited a test that does not
      cover it. Closing it needs a Lava-only pin.
      _Found while reviewing, not fixed:_ escape sequences inside an import specifier
      are passed through raw rather than interpreted, so a line continuation
      (`import d from './dep\`+LF+`.mjs'`) resolves in node and reports
      `Cannot find module './dep\<LF>.mjs'` in Lava. Pre-existing and unrelated to the
      hardening; the specifier reaches `require()` as source text via `jsonString`
      instead of as the parsed string value.
      It also got **faster**, which is not the usual direction for a hardening pass —
      but only ONE change is responsible, and the first draft of this entry credited
      three equally. Ablating one optimization at a time on the same corpus:
      `preReplaceMeta`'s `indexOf` fast path is essentially all of it (the old code
      rebuilt **both** the source and the mask character by character on every module,
      whether or not `import.meta` appeared, and most modules do not); `buildMask`'s run
      batching is ~1 ms here though 2.4x on a 1 MB code-dominated module; and hoisting
      the regexes to literals is **not resolvable against the noise floor** despite
      removing 660 `new RegExp` compiles per run — it is a security change and must not
      be sold as the speedup.
      On a 61-module corpus (~600 bytes each, license block comment, template literals
      with nested `${}`, five export forms), `lava run` cold, medians of 21 interleaved
      launches per arm against a build of `origin/master`: **0.83x** end to end (86.0 to
      71.7 ms loaded, 58.2 to 48.5 ms quiet — the ratio is stable across sessions, the
      absolute ms are not).
      The transform's own ratio needs a **control**, and subtracting only process
      startup — what this entry originally did — leaves resolution, JSC compile and
      evaluation in the number (14.1 ms, against 25.9 ms of transform). Measured against
      a pre-transformed CommonJS twin of the same corpus instead, the twin is unchanged
      between builds (0.99x, so nothing outside the transform moved) and the transform
      is 39.7 to 25.9 ms, **0.65x**; an independent harness on a differently generated
      corpus put it at 0.52x, so read it as 0.5–0.65x, not a third significant figure.
      Not yet recheckable from the tree: there is no `bench/micro/esm.js`, so this
      number has no floor and a future `buildMask` change can give it back silently —
      the same gap that let a +6% to +20% `new URL` regression ship.
- [x] **`util.format` ignored Node's single-argument rule** — fixed: a string
      first argument with nothing after it is returned verbatim, directives and
      all. Lava ran the substitution loop regardless and folded `%%` to `%`;
      exactly 8 rows of a 31-row contract probe against node 24 diverged, all of
      them `%%` with one argument. The directive cases (`%s`, `%z`, `100%`) already
      matched by a different route — the "arguments exhausted" branch re-emits
      `'%' + spec` — which is why the guard belongs before the loop, not in it.
      Both implementations were wrong: `node/util.js` behind `util.format`, and
      `console.js`'s own `formatArgs` behind `console.log`. The duplication stays,
      justified: `console.js` is the bootstrap prelude, takes the native write
      functions as arguments, and has no `require` to delegate with.
      Pinned by `57-format-single-arg.js` and TWO manifest entries — removing one
      guard leaves the other path correct, so a single entry would have reported
      coverage it did not have.
      Latent rather than live when found: no committed case contained `%%`, so
      nothing was mis-comparing. A future one would have, silently, on both sides.
- [x] **`decode-utf16le` breaches its cap ~3 runs in 8, and `bench-gate` is not in
      CI** ([#362](https://github.com/x-ror/lava/issues/362)) — measured 2026-07-30
      over 8 `--gate` runs: 11.07x, 14.01x, 14.44x,
      14.63x, 15.22x, 15.61x and two unrecorded passes, against a 14.5 cap. Recalibrated
      in `bench/thresholds.json` (together with #336/#403 URL caps observed across 4
      `ubuntu-latest` CI runs) and enabled `make bench-gate` in `.github/workflows/ci.yml`.
- [ ] **`Object.prototype.then` is an uncounted, easily-set pollution vector**
      ([#353](https://github.com/x-ror/lava/issues/353)) —
      a plain data property, so an ordinary merge/`obj[a][b]=c` gadget sets it,
      no `defineProperty` needed. Verified under `bin/lava`: `await { plain: 1 }`
      and `Promise.resolve(obj)` both execute attacker code inside an internal
      await, and internals carry 5 awaits plus ~31 `.then(` sites. The ratchet
      cannot see the implicit read (an explicit `p.then(cb)` IS counted, as
      `method`; `await x` and `Promise.resolve(x)` carry no member expression to
      count), so this needs a code convention instead: never `await` a
      caller-supplied value directly, or route it through a captured
      `PromiseResolve`. Same shape for the iterator protocol (`for…of`, spread)
      on caller-supplied values.
- [x] **Promise ↔ event-loop ordering.** JSC drains its own promise microtask
      queue at every C-API boundary, so `Promise.then` used to run _before_
      `process.nextTick` (Node is the reverse). `queueMicrotask` lives in a JS shim
      (`js/bootstrap/microtasks.js`) that schedules a JSC microtask, so it shares one
      FIFO with promise jobs. `process.nextTick` keeps Node's **absolute** priority
      by _not_ living in JSC's queue: nextTick callbacks accumulate in a JS-owned
      queue, and native drains it at two checkpoints that recreate Node's
      `do { drain nextTicks; run microtasks } while (nextTicks)` loop on top of
      JSC's auto-drain — checkpoint 1 (`dispatch`) runs every event-loop callback
      and drains nextTicks before returning across the C boundary (so a nextTick
      beats a promise job queued earlier in the same turn); checkpoint 2 re-drains
      after JSC auto-drains the promise jobs (so a nextTick queued _first inside a
      microtask_ still runs after the microtask queue empties). The top-level turn
      gets checkpoint 1 via a drain appended to the entry source. Passes the full
      `01`/`09`/`10` set, including absolute priority — fully portable, no
      `JSC::VM::DrainMicrotaskDelayScope`. See issue #16 and
      `globals.odin:invoke_user_callback`. _(`fetch`/`fs` completions route through
      the same dispatch path so callbacks they run get the same ordering.)_
- [x] **ESM** — `.mjs` files, static `import` / `export`, `import.meta.url`, and
      `node:url` `fileURLToPath` now work. JSC's classic C API
      (`JSEvaluateScript`) only runs script-goal source, so an ESM→CommonJS
      source transform (`js/bootstrap/esm.js`, stored on `Runtime_State` and
      applied by `native_require_cb` / the `.mjs` entrypoint) rewrites the static
      module syntax onto the existing native `require`, tagging the namespace with
      a non-enumerable `__esModule` for CJS↔ESM default interop. Handles only
      static, statement-position forms — anything else errors explicitly rather
      than mistranslating. _(passes `01-esm`, `12-esm-features`.)_ _Divergence:_
      named imports from a CJS module are resolved by runtime destructuring, so
      Lava accepts some that Node's static cjs-lexer rejects.
- [x] **Native CSPRNG** — `crypto.randomBytes`/`randomUUID`/`randomFill*` now
      draw from the OS CSPRNG via `crypto.rand_bytes`, replacing `Math.random`.
- [x] **Real network transport for `fetch()`** — `http://` and `https://` over
      non-blocking sockets on the event loop. The connect→[TLS]→write→read state
      machine is shared (`pkg/runtime/fetch_transport.odin`); each platform
      supplies narrow socket primitives plus a swappable TLS backend. Implemented for
      **Linux** (io_uring/epoll, `core:sys/linux`), **macOS** (kqueue,
      `core:sys/posix`), and **Windows** (`select`, Winsock). TLS uses OpenSSL on
      Linux/Windows (`pkg/runtime/tls.odin`); on Windows the machine certificate store
      is loaded into OpenSSL's trust store; on **macOS** it uses Apple's
      Security.framework / SecureTransport natively (`pkg/runtime/tls_darwin.odin`,
      #143), verifying against the system keychain with no OpenSSL dependency. DNS resolves
      off the loop on a **bounded resolver pool** (4 workers, lazily created;
      `pkg/runtime/fetch_dns_pool.odin`), which resolves both families and returns an
      ordered IPv4-then-IPv6 list (#77, #145) — replacing the former one-thread-per-
      lookup. All three platforms build and run for real in CI — the Windows job links
      a JavaScriptCore-backed `lava.exe` and runs it. HTTP correctness landed too —
      redirect following, `Set-Cookie`/`getSetCookie()`, URL/port validation, response
      head + chunk-size caps, EINTR retries (#99) — and the connect path now falls back
      across the resolved-address list (#145).
      Follow-ups: Happy Eyeballs — staggered/raced IPv4/IPv6 connects — and multiple
      A/AAAA records beyond the first per family (remaining part of #145).
- [x] **Streaming fetch bodies (#31)** — `response.body` is a real, incrementally
      fed `ReadableStream` (`getReader().read()`, async iteration, `cancel()`,
      `tee()`, `locked`). The transport delivers status + headers as soon as they
      parse, then pushes decoded body chunks (incremental chunked de-framing and
      Content-Length / read-until-EOF identity framing) until the body completes or
      errors — no full-body buffer is kept. The buffered accessors (`text()`,
      `json()`, `arrayBuffer()`, `bytes()`) drain the same stream, so streaming and
      buffering share one consumption path and a body is consumed at most once.
      Backpressure pauses the socket read when the consumer saturates the
      high-water mark and resumes on drain; an abandoned body no longer pins the
      loop (Node parity). Cross-platform via the shared transport
      (`pkg/runtime/fetch_transport.odin`). Verified by `make test-fetch-smoke`.
      Lifetime note: the io_uring backend truly cancels a watcher's `POLL_ADD` on
      `unwatch_fd` (`IORING_OP_ASYNC_CANCEL`) and keys every poll by a generation
      token, so a straggling completion after a paused/resumed read or an abort is
      dropped without touching freed memory (#183); the pointer-based backends
      (epoll/kqueue/select) still reclaim a settled request two loop iterations
      later, to outlast a readiness event already copied into an in-flight poll batch.
- [x] **Streaming fetch request bodies (#182)** — a `ReadableStream` / async-iterable
      request body now streams **incrementally as `Transfer-Encoding: chunked`** rather
      than being buffered to bytes first: the head is written, then chunks are pulled
      one at a time from the JS producer (a `pushBody`/`endBody` ⇄ `onBodyDrain`
      channel mirroring the response pull path), framed, and written to the socket —
      no full-body buffer is kept on either side. Socket write backpressure pauses the
      producer (the next pull is deferred until the current frame drains, mirroring the
      response read resume); a producer error or an abort signal tears the in-flight
      upload down. Cross-platform (plaintext + TLS) via the shared transport. A `Blob`
      (known length) and string/Buffer/typed-array bodies keep the buffered
      Content-Length fast path. Limitations: half-duplex only (the whole request body
      is sent before the response is read, matching `duplex: 'half'`); an
      immediately-empty producer is sent as an empty chunked body (terminator only)
      rather than Node's `Content-Length: 0`; a server that rejects chunked request
      bodies (or closes mid-upload) surfaces as a failed request. Verified by
      `make test-fetch-smoke`.
- [x] **Event-loop I/O driving** — fetch was the first real `watch_fd` consumer
      and exposed several gaps, now fixed (`pkg/runtime/eventloop/`): - io_uring `POLL_ADD` mask is written to `poll_events` (was `addr`, so no
      fd poll ever fired) and SQEs are submitted at arm time (not only at the
      next `poll`, which a due timer could skip indefinitely). - `run_until_idle` blocks in `poll` when a socket is the only pending work,
      and advances the virtual clock on a timer-deadline wake so a timer
      co-pending with I/O is not dropped. - timer delays are floored at 1ms (Node parity), so a 0ms timer cannot
      busy-spin and starve pending I/O. Settled requests are reclaimed on the
      next request (bounded retention), not held until teardown.

### Medium priority (more of the Node surface)

- [x] **`TextEncoder` / `TextDecoder` / `structuredClone`** globals (pure JS;
      TextEncoder/TextDecoder reuse the buffer utf8 codec; structuredClone is the
      HTML clone algorithm in `js/internal/structured_clone.js`). _(cases `11`, `13`.)_
- [x] **Full `node:path`** — `resolve`, `relative`, `normalize`, `dirname`, `sep`,
      `delimiter`, `parse`, `format`, and the `posix`/`win32` namespaces, ported to
      JS (`js/node/path.js`) so semantics match Node exactly; the partial native
      implementation was retired. _(case `02`.)_
- [x] **More `node:fs`** — `writeFileSync` (string/Uint8Array), `mkdirSync`
      (`recursive`), `statSync` (`Stats` with `size`/`*Ms` times + `isFile`/
      `isDirectory`/`isSymbolicLink`), `readdirSync`, `rmSync` (`recursive`/`force`),
      and async `writeFile`. _(case `02`.)_ Deferred: async `stat`/`readdir`/`mkdir`,
      `fs.promises`, file handles, watchers.
- [x] **Wire `pkg/std/sqlite`** — `node:sqlite` (`DatabaseSync` with
      `exec`/`prepare`/`isOpen`/`close`, `StatementSync` with `get`/`all`/`run`
      and `?` parameter binding; INTEGER/REAL/TEXT/BLOB/NULL coercion). Native
      libsqlite3 bindings in `pkg/std/sqlite`; JSC bridge + handle registry in
      `pkg/runtime/sqlite.odin`; JS surface in `js/node/sqlite.js`. Needs the
      sqlite3 dev package (Linux: `libsqlite3-dev`; macOS: system sqlite3). Runs
      the oracle through Lava via `make test-sqlite-lava`.

### Low priority / correctness polish

- [x] **`console.log` truncated to one pipe buffer on a non-blocking stdout** — fixed
      (#325). `os.write` abandons its loop on any errno and `process_write` discarded both
      the count and the error, so a full pipe ended the write and exited 0:
      `console.log('x'.repeat(300000))` delivered 65536 of 300001 bytes where node 24.18.1
      delivered all. Nothing in Lava sets `O_NONBLOCK` on fd 1/2 — the flag is inherited —
      so a shell pipe never reproduced it and a process manager did, which is why a 1 MB
      blocking-pipe check passed while the bug was live. `process_write_all` re-slices by
      the bytes actually written and waits on `POLLOUT` rather than spinning.
      The merge gate found the first cut incomplete: `lava eval` and the synchronous throw
      report go through `fmt.println`/`fmt.eprintln`, not `process_write`, and still
      truncated — so the two error paths disagreed on the same input. `print_result` now
      routes through the fixed writer.
      _Accepted cost, measured:_ a full stdout parks the loop thread until the reader
      drains (node fires 19 timer ticks during a 2s stall, Lava 0). Lava already behaved
      that way for a **blocking** pipe; the fix makes a non-blocking one join that shape
      instead of dropping 99.94% of the payload. Bulk output afterwards is 231.8 MB/s
      against node's 397.7 on the same harness.
      _Still open:_ darwin is unfixed — `core:os` collapses a failed write to
      `General_Error` there, so the errno never reaches the retry classifier. Recorded at
      the site rather than left to read as covered.
      Pinned by `tests/stdio/stdio-write.test.mjs` (`make test-stdio`, post-build in CI)
      and a mutation entry.

- [x] **Host-native dispatch answered a miss with `undefined`** — fixed (#320):
      the registry fails closed. A miss meant our own tables were inconsistent,
      and several natives write through a caller-supplied buffer and signal
      nothing on return, so `undefined` forged success — `crypto.randomBytes`
      would have returned a zeroed `Buffer.alloc` as CSPRNG output, `fromString`
      uninitialized `allocUnsafe` pool memory. The miss now raises, `host_throw`
      reports whether it actually raised, and `crypto.js` identity-checks
      `randomFill` as a second layer.
- [x] **`platform_init` double-closed the wakeup pipe on the epoll failure
      path** — fixed: it closed both ends but left their NUMBERS in
      `wakeup_pipe`, and `destroy` calls `platform_destroy` unconditionally, so
      they were closed again. A wrong-fd close, not a leak, and the trigger is
      EMFILE — precisely when the kernel is recycling numbers, so the second
      close lands on an unrelated descriptor. darwin already reset; Linux now
      does too, pinned by `failed_platform_init_does_not_double_close`, which
      tightens `RLIMIT_NOFILE` and requires a canary on the recycled number to
      survive teardown.
- [x] **`clearInterval` leaks** the `JS_Callback` heap binding + GC protection —
      fixed: the loop's dispose hook (`js_callback_dispose` in
      `pkg/runtime/globals.odin`) frees the binding when an interval is cleared.
- [x] **`setTimeout`/`setInterval` ignore extra trailing args** — fixed:
      `capture_timer_args` clones and GC-protects the trailing arguments and
      forwards them to the callback (Node parity).
- [x] **`bench --gate` reads a single launch** — fixed: `--gate` now takes the
      MEDIAN of 3 launches per side (`collectMedian` in `bench/run.mjs`);
      report-only runs still take one, since they fail nothing and so pay no
      false-positive cost. The single-launch estimator's measured spread was
      1.11-1.28x quiet and up to 2.26x under load, so a cap sized to catch a ~1.4x
      regression could not separate the two; median-of-3 cuts the loaded-box
      false-positive rate ~40% with detection unchanged at 100%, for ~16s of CI.
      One deliberate carve-out: `startup` stays a single best-of-15 spawn series
      even under `--gate` (spawn noise is one-sided, so min-of-N is the right
      estimator there, unlike the in-process benches). Do NOT "fix" the
      remaining variance by pinning: pinning shifts the ratio level 25-40% (it
      hurts node more than Lava) and would invalidate every cap in bench/thresholds.json.
- [ ] **Host-native registry: consider moving `g_host_native_fns` onto
      `Runtime_State`** ([#359](https://github.com/x-ror/lava/issues/359)) — it is
      read only at registration and in the sweep, never
      on the dispatch path (only `g_host_native_cbs` is), so keying it by the
      context pointer buys nothing and it could die with the state, deleting the
      sweep entirely. Not done here for a measured reason: the cache-HIT path is
      hot (~60k hits per 20k `fs.statSync`, three per `Stats` instance) and
      currently returns before any state lookup; moving the table would add
      `JSContextGetGlobalObject` + `JSObjectGetPrivate` to every hit. Needs a
      profile before committing to it.
- [ ] **Stack-trace line numbers are off by one**
      ([#357](https://github.com/x-ror/lava/issues/357)) — the CommonJS wrapper
      prepends a line but `JSEvaluateScript` starts at line 1.
- [ ] **`make_uint8_array_uninit` leaks its allocation when the typed-array
      creation fails** ([#358](https://github.com/x-ror/lava/issues/358)) —
      `typed_array.odin:114-126` returns `nil, false` after
      `mem.alloc_bytes_non_zeroed` succeeded but JSC declined to take ownership, so
      `jsc_buffer_deallocator` never runs for it. Reachable from the buffer pool
      refill path, i.e. under memory pressure. Testing it needs the fault-injection
      seam above.
- [ ] **Two native-function divergences, both declared and pinned, neither
      repairable from the public C API** — recorded so nobody re-derives them.
      (a) On the host path `new setTimeout(fn)` evaluates to the CALL result,
      `undefined`, where Node (like any ordinary function) yields an object:
      `create_raw` reuses the call callback as the constructor slot. (b) On the
      C-API fallback every native reports `.length` 0 and is not constructible;
      `JSObjectSetProperty` cannot fix it, because `length` is inherited from
      `Function.prototype` so the call degrades to a `[[Set]]` against a
      non-writable slot. Both are analysed at `inject_native_function`
      (`require.odin`) and pinned — (a) by
      `host_native_construct_returns_call_result`, (b) by
      `host_native_create_declines_without_state` plus
      `tests/node-compat/cases/56-native-function-arity.js` for the default
      configuration. Fixing either needs a JS-level `defineProperty` during
      global installation; not worth it for a path taken only when the private
      ABI is missing.
- [ ] **Each `JSGlobalContext` costs one leaked `timerfd`**
      ([#356](https://github.com/x-ror/lava/issues/356)) — JavaScriptCore's
      per-VM `WTF::RunLoop` timer. Measured 2026-07-29: +1 per context, strictly
      linear over 20 iterations, reproduced by a bare
      `JSGlobalContextCreate`/`Release` pair with no event loop, no script and no
      `Runtime_State`; unchanged by a forced `JSGarbageCollect`, by passing `nil`
      instead of our `JSClass`, or by waiting. One context running many scripts
      costs one fd, so the price is per VM. JSC's own GSource `finalize` does
      close it, so the fd survives because the VM is never finalized — the fix is
      getting the VM actually destroyed (or an upstream report), not a `close()`
      of our own. NOT a live defect in what we ship: one context per
      `lava run`/`lava eval` process and one per worker, both bounded. It bites
      the Odin test binary (hence the baseline-differential fd census in
      `cmd/lava/net_teardown_stress_test.odin`) and any embedder calling `eval`
      repeatedly in one process. Details at `release_global_context_after_eval`.
- [x] **Repeated `lava.eval` in one process degrades** — fixed: the thread-local
      host-call registry in `pkg/runtime/host_natives.odin` is keyed by the JSC
      context POINTER, and JSC reuses that address for a later
      `JSGlobalContextCreate`. Nothing dropped a dead context's entries, so from
      the 3rd-4th eval the key collided and the cache returned a `JSObjectRef`
      into freed memory — observed as the `allocUninit` binding resolving to
      `Map.prototype.values` out of `buffer.js` `createPool`, and as segfaults or
      tracking-allocator bad frees under the Odin test runner.
      Two lifetime bugs in the same tables, both fixed: (a) the ENTRIES were
      never dropped when a context died — `host_natives_release_context` now
      sweeps both tables from `destroy_runtime_state` while the context is still
      alive; (b) the map BACKING was bound implicitly to whatever
      `context.allocator` was live at the first insert (Odin binds a zero-valued
      map's allocator on first grow) even though the tables are thread-lived, so
      under the test runner's per-test tracking allocator, or an embedder's arena,
      later inserts wrote through reclaimed memory — both are now bound explicitly
      to a process-lifetime allocator. Pinned by `cmd/lava/repeated_eval_test.odin`
      and `cmd/lava/host_native_alloc_test.odin` (both mutation-verified in each
      direction). The pre-fix bug was not crash-only: a working proof-of-concept
      showed a native call running a DIFFERENT native's Odin callback, with the
      registration order steerable from user JS via `require()` order —
      embedder- and test-runner-reachable, not remotely. (Two earlier suspicions
      were wrong and are recorded as such: the `thread_local` probe state in
      `pkg/jsc/private_string.odin` is VM-independent and was never implicated,
      and the residual failure was not a separate defect in
      `pkg/runtime/eventloop/loop.odin`.)
- [ ] **Prototype-pollution hardening of the embedded JS layer**
      ([#352](https://github.com/x-ror/lava/issues/352) · epic) — `primordials.js`
      plus the `make check-primordials` ratchet over
      `tests/node-compat/pollution-baseline.json`. Done in the `method` column:
      `events.js`, `dns/promises.js`, and the encoding-name path of `buffer.js`;
      `encoding.js` sits at 1, not 0. Seven files are 0 in all four classes. Six of
      them are no evidence of hardening — each is a 6–19 line re-export shim
      (`node/console.js`, `dns/promises.js`, `path/posix.js`, `path/win32.js`,
      `process.js`, `timers.js`). The seventh, `esm.js`, is 917 lines of real logic
      and is the first such file to reach 0 in all four.
      Remaining in `method`: `url.js` (the type-ambiguous
      `slice`/`indexOf`/`includes` sites, plus its percent-decode byte arrays,
      which are still plain arrays and so reachable via an `Array.prototype[0]`
      accessor), `buffer.js`, `path.js`, `util.js`, and the newly
      in-scope `console.js`.
      **Unblocked**: the ratchet counts four classes separately, so that list is
      the `method` column only; the other three are recorded per file in
      `pollution-baseline.json` and are the larger part of the work. Read the
      current split from `make check-primordials` rather than from prose here —
      copied totals went stale twice. Take them per file, lowest-hanging first:
      capturing a module's globals at module-eval is mechanical and drives its
      `global` column to 0, which `encoding.js` already demonstrates. Note
      `primordials.js` reads 9 in `invoke` **by construction** — every `callerN`
      wrapper is a `fn.call` — while its `global` column is 1, because the
      module-eval rule already exempts the capture table. Neither is work.
      **Next, and it is the largest single win left**: wire `lockIntrinsics()`.
      It is written and exported in `primordials.js` and called from nowhere, so
      the whole `invoke` class is live today. Now that the class is counted it is
      also measurable, and the exposure is worse than the "exotic axis" the file
      header used to call it: replacing `Function.prototype.call` makes Lava throw
      where Node succeeds (TextDecoder/TextEncoder construction, `Buffer.from`,
      `buf.toString`, `Buffer.concat`, `new URL`) and — worse — answer _wrongly_
      where Node is right (`URLSearchParams.get` → `null`, `util.format` →
      `'undefined'`). Not hypothetical: instrumentation and tracing libraries wrap
      `Function.prototype.call` for legitimate reasons.
      Converting the wrappers to `Reflect.apply` instead was measured and is not
      the answer for the hot ones — `bin/lava` vs a build with `caller0..3`
      rewritten, end to end: `new URL` 1.76x, `EventEmitter.emit` 1.63x,
      `decode(5B)` 1.49x, `URLSearchParams.get` 1.41x, `toString('hex')` 1.28x,
      TextDecoder ctor 1.21x, `decode(1800B)` 1.11x. URL parsing and event
      emission are on every HTTP request, so ~1.7x there is not payable.
      But the same table says the conversion is **free** (~1.00x) for
      `Buffer.from`, `TextEncoder.encode`, `util.format`, `path.join` and
      `structuredClone`, so the work splits cleanly: `lockIntrinsics()` at
      bootstrap for the hot paths at zero per-call cost, and `Reflect.apply` for
      the wrapper-sparse cold ones regardless.
      One site is already done, and it shows a third option worth looking for
      first: `encoding.js` reached the utf-8 and utf-16le decoders as
      `Buffer.prototype.toString.call(bytes, enc)`, which put the live `.call` read
      on decode()'s **return** path — `decode()` handed back the replacement's
      ArrayBuffer instead of a string. It now takes `utf8Decode`/`utf16leDecode`
      straight from the loader's native argument, which needs no `Function.prototype`
      read at all and is FASTER than the `.call` it replaced (0.74x on a 9-byte
      decode, 0.91x on a 20-parameter URLSearchParams parse, medians of 7
      interleaved launches) because toString's length getter, range clamp and
      encoding-name dispatch drop out. Pinned by vector V in
      `55-encoding-pollution.js`. Where a JS layer is borrowing a prototype method
      that only wraps a native we already own, going to the native beats both
      `.call` and `Reflect.apply` — check for that before reaching for either. The open question is only
      `lockIntrinsics()`'s own Node deviation — Node leaves the intrinsics
      writable, so a program assigning `Function.prototype.call` would silently
      not take effect; that narrower divergence needs a Lava-only test pinning it
      per §1, plus a full `make test-lava` pass to find what in the oracle suites
      legitimately writes an intrinsic.
- [x] **`run_until_idle` ended the drive on one no-progress tick** — fixed: it
      now keeps polling while `active_io_count` or `active_async` is nonzero, the
      invariant `run()` has carried since #113 (ba12bd3) and which that fix reached
      only on `run()` — its own comment says so, "(run_until_idle keeps its bounded
      form for deterministic tests)", and the bounded form silently kept the early
      return too.
      A no-progress tick is routine, not exceptional: `post_async` appends the
      completion under `async_mutex` and writes the wakeup byte after unlocking,
      while the poll drains the pipe and `drain_async` drains the queue at different
      instants — and `drain_async` takes the whole queue per pass, so one byte can
      carry two completions and leave a surplus byte that pops the next blocking
      poll with nothing to drain. Draining a wakeup deliberately does not count as
      I/O progress, so that tick reports `false`, and the old code returned the
      `did_work` an earlier tick had latched. It therefore read as SUCCESS, which is
      why it survived: CI saw 2-of-3 completions with `active_async == 1` and no
      failure on the `run_until_idle` assertion itself.
      Found by a one-off CI failure in
      `threadpool_runs_work_offloop_and_completes_on_loop`, at roughly 1-2% per run
      under CI's 4-core oversubscription — 40 solo runs, 25 whole-suite runs and 20
      runs under `taskset -c 0,1` on a 16-core box all came back clean, so the
      reproduction had to come from reading the driver rather than from load.
      Pinned by `run_until_idle_waits_out_a_stale_wakeup`, which is the existing
      `run_ignores_stale_wakeup_while_async_is_active` with `run` swapped for
      `run_until_idle` — the hazard already had a test, on the other driver only.
      It carries NO timer on purpose: a pending timer gives `platform_poll` a
      positive timeout, and a positive-timeout poll counts as progress by itself, so
      the no-progress tick never happens and the bug hides. A first version used a
      timer to avoid the thread, passed, and passed just as well with the fix
      reverted.
      `scripts/run-tests.sh` also ran this suite multithreaded while
      `make test-eventloop-odin` pinned one thread for a stated reason, so CI
      contradicted the documented requirement; aligned. That is not the race fix —
      the defect reproduces at one thread, and deterministically with no threadpool
      at all (`async_begin` plus a `set_immediate` that calls `wakeup` returns in
      ~9us with `active_async == 1`).
- [x] **Real wall-clock timers** — fixed: in `real_time` mode the loop tracks the
      monotonic wall clock (`sync_real_clock` / `real_now_ms` in
      `pkg/runtime/eventloop/loop.odin`), so `setTimeout(fn, 1000)` fires after a
      second instead of immediately.
- [x] **`Buffer` offset/value/UTF-8 validation parity (#107)** — fixed:
      `write`/`fill`/`copy` reject negative & non-integer offsets (no wrap-around),
      the `write*` integer accessors range-check their value, the variable-width
      `read*`/`write*` require an integer `byteLength` 1..6, `fill` rejects an
      unrepresentable value (`ERR_INVALID_ARG_VALUE`), and `toString('utf8')` uses
      the Unicode maximal-subpart U+FFFD rule (`pkg/runtime/buffer.odin`). WHATWG
      `TextDecoder` now honors `{ stream: true }` and `fatal` for utf-8/utf-16le
      (`pkg/runtime/js/internal/encoding.js`). Verified vs Node 24 + Bun.
- [x] **Catchable oversized-`Buffer` allocations (#186)** — `Buffer.alloc`/
      `allocUnsafe` and raw `new Uint8Array(n)` past the practical JSC ceiling now
      throw a catchable `RangeError` instead of aborting the process (the
      `kMaxLength` cap + the typed-array allocation guard, #200).

### CI / tooling housekeeping

- [x] **Give the gates one honest runner**
      ([#360](https://github.com/x-ror/lava/issues/360)) — `make gates` (`scripts/run-gates.mjs`)
      routes changed paths through `runtime/gates/route-gates.mjs`, executes each target
      without a `| tail` pipe masking its exit status, stops at the first failure, and
      prints a summary table.
- [ ] **A test-only fault-injection seam for JSC-side failures**
      ([#361](https://github.com/x-ror/lava/issues/361)) — three
      safety-critical branches are accepted-untested today because the fault has
      to happen _inside_ JSC: the paired `map_insert` rollback in
      `host_native_create`, the `fillRandom` identity check in `crypto.js`, and
      `ensure_host`'s transient-vs-definitive retry. Each is code that only runs
      when an invariant is already broken, which is exactly the code least likely
      to be exercised and most expensive to get wrong. One env-gated seam
      (`LAVA_HOSTFN_DISABLE` is the precedent) unlocks all three.
- [x] Pin a specific Odin release in CI (`dev-2026-11a` with `llvm-version: '18'`,
      [#35](https://github.com/x-ror/lava/issues/35)), and pin Node `26.13.0` in
      `.nvmrc` as a major floor checked by `scripts/lib/compare.sh` (#185).
- [x] Update `actions/checkout` (`v7`) / `actions/setup-node` (`v7` with
      `node-version-file: .nvmrc`) past the Node 20 deprecation warning
      ([#35](https://github.com/x-ror/lava/issues/35)).
- [x] Real `odin build` + run job for Windows: the CI Windows job links a
      JavaScriptCore-backed `lava.exe` (JSC from the Bun WebKit fork) and runs a
      runtime smoke, on top of type-check + codegen.
