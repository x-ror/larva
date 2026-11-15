# Lava ↔ Node.js API compatibility matrix

Coverage of the Node.js public API surface in **lava**.

The scoreboard, the page table, the globals and `process` lists and the N/A table
are **generated** by [scripts/node-compat/gen-matrix.py](../scripts/node-compat/gen-matrix.py)
from the same table that produces [node-compat.json](node-compat.json) — edit the
script, not the blocks between the `GENERATED` markers. The prose sections are
written by hand.

- **Node docs source:** `nodejs/node` `doc/api` @ the commit recorded in [node-doc-api/SOURCE.txt](node-doc-api/SOURCE.txt) (70 pages, mirrored under [node-doc-api/](node-doc-api/)).
<!-- BEGIN GENERATED: provenance -->

- **lava revision measured:** `8e83f8d` (2026-11-15), export keys diffed against node 24.22.1.

<!-- END GENERATED: provenance -->
- **Method:** every row was probed against the built `bin/lava` (`require('node:x')`, export-key diff against node, global lookups, and calling exported functions) — not inferred from source. Functions that exist but throw `"... is not implemented in Lava"` are counted as _not_ implemented. A gap that cites an issue number comes from that issue, not from the probe.

**Legend:** ✅ implemented (substantial) · 🟡 partial (core works, notable gaps or many stubs) · 🟥 missing (none of the page's surface exists; for a module page, `require` throws `MODULE_NOT_FOUND`) · ⚪ N/A for a JS-API matrix (native-addon / CLI / conceptual guide).

## Scoreboard

<!-- BEGIN GENERATED: scoreboard -->

| Status | Count | Pages |
| --- | ---: | --- |
| ✅ Full | 12 | assert, buffer, diagnostics_channel, events, intl, os, path, punycode, querystring, sqlite, string_decoder, url |
| 🟡 Partial | 21 | console, crypto, dns, environment_variables, esm, fs, globals, http, https, module, modules, net, packages, perf_hooks, process, stream, timers, tty, util, webcrypto, webstreams |
| 🟥 Missing | 27 | async_context, async_hooks, child_process, cluster, dgram, domain, dtls, ffi, http2, inspector, permissions, quic, readline, repl, report, single-executable-applications, stream_iter, test, tls, tracing, typescript, v8, vfs, vm, wasi, worker_threads, zlib |
| ⚪ N/A | 10 | addons, cli, debugger, deprecations, documentation, embedding, errors, index, n-api, synopsis |

<!-- END GENERATED: scoreboard -->

`intl` is provided by the JavaScriptCore engine, not by lava code.

## Pages

The `require` column gives the specifier that loads, or ❌ when the page has no
requireable module in lava (the surface is global-only, or absent).

<!-- BEGIN GENERATED: modules -->

| Page | `require` | Status | Implemented | Gaps |
| --- | :---: | :---: | --- | --- |
| **assert** | `node:assert` | ✅ | node:assert + assert/strict, AssertionError, partialDeepStrictEqual | Assert class, CallTracker; deepStrictEqual divergences (#103) |
| **async_context** | ❌ | 🟥 | — | AsyncLocalStorage |
| **async_hooks** | ❌ | 🟥 | — | — |
| **buffer** | `node:buffer` | ✅ | Buffer/Blob/File/SlowBuffer/isAscii/isUtf8/transcode/resolveObjectURL; module-level atob/btoa (+ global URL.createObjectURL/revokeObjectURL) | atob/btoa are not installed as globals (#86); exports a lava-only describeType |
| **child_process** | ❌ | 🟥 | — | — |
| **cluster** | ❌ | 🟥 | — | — |
| **console** | `node:console` | 🟡 | global console + node:console module with a Console class | context/createTask/profile/profileEnd/timeStamp; Console ignores its stdout/stderr streams (#104) |
| **crypto** | `node:crypto` | 🟡 | 19 working: createHash/createHmac/hash/Hash/Hmac/getHashes/hkdf(Sync)/pbkdf2(Sync)/scrypt(Sync)/randomBytes/randomFill(Sync)/randomInt/randomUUID/timingSafeEqual/getFips | 47 exported stubs that throw: ciphers/KeyObject/sign/verify/X509Certificate/ECDH/DH/KEM/argon2/primes/generateKey\*/setFips/randomUUIDv7; createMac/getMacs/parsePKCS12 absent |
| **dgram** | ❌ | 🟥 | — | — |
| **diagnostics_channel** | `node:diagnostics_channel` | ✅ | channel/hasSubscribers/subscribe/unsubscribe/tracingChannel/Channel (all 6 exports) | — |
| **dns** | `node:dns` | 🟡 | lookup + dns/promises lookup (thread pool), constants and error codes | 17 exported stubs that throw: resolve\*/reverse/lookupService/getServers/setServers (#179); resolveTlsa absent; dns/promises lacks the error-code constants |
| **domain** | ❌ | 🟥 | — | deprecated upstream |
| **dtls** | ❌ | 🟥 | — | — |
| **environment_variables** | ❌ | 🟡 | some env honored | — |
| **esm** | ❌ | 🟡 | .mjs transform, import works | loader hooks/register |
| **events** | `node:events` | ✅ | EventEmitter, once, on, getEventListeners, getMaxListeners, setMaxListeners, listenerCount, addAbortListener, defaultMaxListeners | EventEmitterAsyncResource/errorMonitor/captureRejections; no EventTarget/CustomEvent globals; meta-events (#105) |
| **ffi** | ❌ | 🟥 | — | — |
| **fs** | `node:fs` | 🟡 | 15 fns: readFile/readFileSync/writeFile/writeFileSync/openSync/closeSync/existsSync/mkdirSync/mkdtempSync/rmSync/rmdirSync/unlinkSync/renameSync/statSync/readdirSync; reads return Buffer and honor the encoding (JS layer, #330) | no node:fs/promises, streams, watch, copyFile/access/chmod, async stat/readdir/mkdir, constants (#84) |
| **globals** | ❌ | 🟡 | 40 globals present (see globals.present) | atob/btoa, Event/EventTarget/CustomEvent, FormData, DOMException, MessageChannel, navigator, WebSocket, URLPattern, SharedArrayBuffer, byte/compression/text streams (see globals.missing) |
| **http** | `node:http` | 🟡 | server: createServer/Server/IncomingMessage/ServerResponse/STATUS_CODES | no client (request/get/Agent/ClientRequest/globalAgent), OutgoingMessage, METHODS, maxHeaderSize, validateHeaderName/Value, WebSocket (#81) |
| **http2** | ❌ | 🟥 | — | — |
| **https** | `node:https` | 🟡 | server: createServer/Server over the native TLS server | request/get/Agent are exported stubs that throw — the HTTPS client is fetch (#81) |
| **inspector** | ❌ | 🟥 | — | — |
| **intl** | ❌ | ✅ | engine (JavaScriptCore) Intl | engine-provided, not lava code |
| **module** | ❌ | 🟡 | CommonJS require + node: resolution | node:module is not requireable: createRequire/register/isBuiltin/SourceMap |
| **modules** | ❌ | 🟡 | CommonJS require | same as module |
| **net** | `node:net` | 🟡 | createServer/Server/Socket/connect/createConnection (TCP) | isIP/isIPv4/isIPv6, BlockList, SocketAddress, BoundSocket, autoSelectFamily controls |
| **os** | `node:os` | ✅ | all 23 exports present | — |
| **packages** | ❌ | 🟡 | package.json resolution (partial) | exports/imports map edge cases |
| **path** | `node:path` | ✅ | posix+win32 full surface | — |
| **perf_hooks** | ❌ | 🟡 | global performance.now/timeOrigin | node:perf_hooks is not requireable; PerformanceObserver/marks/entries |
| **permissions** | ❌ | 🟥 | — | — |
| **process** | `node:process` | 🟡 | argv/env/cwd/exit/exitCode/nextTick/pid/platform/arch/version(s)/memoryUsage/stdout/stderr; node:process requireable | hrtime/on/once/emit/stdin/kill/chdir/uptime/execPath/argv0/execArgv/umask/title/emitWarning (#355, #86); exitCode is honored when set but is not a predefined property |
| **punycode** | `node:punycode` | ✅ | all 6 exports present | deprecated upstream |
| **querystring** | `node:querystring` | ✅ | parse/stringify/escape/unescape/decode/encode | unescapeBuffer |
| **quic** | ❌ | 🟥 | — | — |
| **readline** | ❌ | 🟥 | — | — |
| **repl** | ❌ | 🟥 | — | — |
| **report** | ❌ | 🟥 | — | — |
| **single-executable-applications** | ❌ | 🟥 | — | tooling |
| **sqlite** | `node:sqlite` | ✅ | DatabaseSync/StatementSync | Session/backup/constants |
| **stream** | `node:stream` | 🟡 | Stream/Readable/Writable/Duplex/Transform/PassThrough/finished/pipeline/addAbortSignal/isReadable/isWritable + node:stream/promises; Readable/Writable toWeb/fromWeb | compose/duplexPair/destroy/isErrored/isDisturbed/isDestroyed/get\|setDefaultHighWaterMark/stream.promises; Duplex.toWeb/fromWeb; no node:stream/consumers |
| **stream_iter** | ❌ | 🟥 | — | — |
| **string_decoder** | `node:string_decoder` | ✅ | StringDecoder | — |
| **test** | ❌ | 🟥 | — | — |
| **timers** | `node:timers` | 🟡 | global timers + node:timers + node:timers/promises | timers return a number, not a Timeout: no ref/unref/refresh (#85) |
| **tls** | ❌ | 🟥 | TLS is used internally by fetch and https.createServer | node:tls is not requireable |
| **tracing** | ❌ | 🟥 | — | trace_events |
| **tty** | `node:tty` | 🟡 | isatty/ReadStream/WriteStream | getWindowSize reads $COLUMNS/$LINES (default 80x24), not the terminal (#355) |
| **typescript** | ❌ | 🟥 | — | no type stripping |
| **url** | `node:url` | ✅ | WHATWG URL + URLSearchParams (global and module); fileURLToPath/pathToFileURL/urlToHttpOptions/format/domainToASCII/domainToUnicode | legacy url.parse/resolve/Url; URLPattern; fileURLToPathBuffer; IDNA approximated (NFKC+Punycode, not full ICU UTS-46) |
| **util** | `node:util` | 🟡 | inspect/format/formatWithOptions/promisify/callbackify/inherits/deprecate/isDeepStrictEqual/debuglog/aborted/parseArgs/parseEnv/MIMEType/MIMEParams/styleText/stripVTControlCharacters/toUSVString/types | TextEncoder/TextDecoder re-exports, diff, getCallSites, getSystemErrorName/Message/Map, debounce/throttle, transferableAbort\*, deprecated isArray; inspect caps (#331) |
| **v8** | ❌ | 🟥 | — | — |
| **vfs** | ❌ | 🟥 | — | — |
| **vm** | ❌ | 🟥 | — | — |
| **wasi** | ❌ | 🟥 | — | WebAssembly present, WASI glue absent |
| **webcrypto** | ❌ | 🟡 | crypto.getRandomValues/randomUUID | crypto.subtle (all SubtleCrypto) |
| **webstreams** | `node:stream/web` | 🟡 | ReadableStream/WritableStream/TransformStream globals + node:stream/web; readers/writers/controllers; pipeTo/pipeThrough; backs response.body | byte streams/BYOB request+controller, TextEncoderStream/TextDecoderStream, CompressionStream/DecompressionStream (#214); node:stream/web exports a lava-only _internal |
| **worker_threads** | ❌ | 🟥 | — | — |
| **zlib** | ❌ | 🟥 | — | — |

<!-- END GENERATED: modules -->

## Globals (`globalThis`)

Probed directly against `bin/lava`.

<!-- BEGIN GENERATED: globals -->

**Present (40):** `global`, `globalThis`, `Buffer`, `fetch`, `Headers`, `Request`, `Response`, `TextEncoder`, `TextDecoder`, `AbortController`, `AbortSignal`, `structuredClone`, `queueMicrotask`, `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`, `clearImmediate`, `console`, `process`, `performance`, `Blob`, `File`, `crypto`, `URL`, `URLSearchParams`, `ReadableStream`, `WritableStream`, `TransformStream`, `ReadableStreamDefaultReader`, `ReadableStreamBYOBReader`, `ReadableStreamDefaultController`, `WritableStreamDefaultWriter`, `WritableStreamDefaultController`, `TransformStreamDefaultController`, `ByteLengthQueuingStrategy`, `CountQueuingStrategy`, `WebAssembly`, `Intl`.

**Missing (33):** `atob`, `btoa`, `Event`, `EventTarget`, `CustomEvent`, `MessageEvent`, `CloseEvent`, `FormData`, `DOMException`, `ReadableStreamBYOBRequest`, `ReadableByteStreamController`, `TextEncoderStream`, `TextDecoderStream`, `CompressionStream`, `DecompressionStream`, `MessageChannel`, `MessagePort`, `BroadcastChannel`, `WebSocket`, `PerformanceObserver`, `PerformanceEntry`, `PerformanceMark`, `navigator`, `Navigator`, `URLPattern`, `SharedArrayBuffer`, `Crypto`, `CryptoKey`, `SubtleCrypto`, `crypto.subtle`, `DisposableStack`, `AsyncDisposableStack`, `SuppressedError`.

<!-- END GENERATED: globals -->

`fetch` streams bodies in **both** directions on the public Web Streams type. `response.body` is a real `ReadableStream` (incrementally fed by the transport — `getReader().read()`, `for await…of`, `cancel()`, `tee()`, `locked`, `pipeTo`, `pipeThrough`), and the buffered accessors `text()`/`json()`/`arrayBuffer()`/`bytes()` drain that same stream (single-consumption enforced). On the request side, a `ReadableStream` or async-iterable body is **streamed incrementally as `Transfer-Encoding: chunked`** — pulled one chunk at a time and written to the socket with write backpressure, never materialized in full (`duplex: 'half'` is required for stream bodies, matching Node). A `Blob` (a known-length body) and string/`Buffer`/typed-array bodies keep the buffered `Content-Length` fast path. fetch and `node:stream/web` share one stream implementation ([js/internal/streams.js](../pkg/runtime/js/internal/streams.js)), so there is no fetch-only fork. Intentional limitations vs Node: streaming is **half-duplex** (the whole request body is sent before the response is read); an immediately-empty stream body is sent as an empty chunked body (terminator only) rather than `Content-Length: 0` (the received body is identical); and a server that rejects chunked request bodies — or closes the connection mid-upload — surfaces as a failed request.

`TextDecoder` ([js/internal/encoding.js](../pkg/runtime/js/internal/encoding.js)) is a WHATWG streaming decoder for `utf-8`, `utf-16le`, and `windows-1252` (the alias for `latin1`/`ascii`). `decode(chunk, { stream: true })` carries an incomplete trailing sequence — a partial UTF-8 code point, a UTF-16 surrogate pair split across chunks, or an odd UTF-16LE byte — into the next call, and a non-streaming `decode()` flushes and resets; a BOM split across chunks is still stripped exactly once. `fatal: true` throws `ERR_ENCODING_INVALID_ENCODED_DATA` on malformed input (lone surrogate, an incomplete sequence at the final flush) where the default replaces with U+FFFD; lone UTF-16 surrogates become U+FFFD (vs `Buffer.toString('utf16le')`, which passes raw code units through, as in Node). UTF-8 uses the same maximal-subpart replacement as `Buffer` (issue #107). Encoding labels follow WHATWG "get an encoding": leading/trailing **ASCII** whitespace is stripped (not other Unicode whitespace — `'\u00a0utf-8'` is rejected, as in Node), the label is lower-cased, and an unsupported one throws `RangeError` / `ERR_ENCODING_NOT_SUPPORTED` with Node's `The "X" encoding is not supported` message. Lava's label table covers only the three codecs above, so the ~24 further encodings Node resolves through ICU (`gbk`, `shift_jis`, `koi8-r`, `iso-8859-2`, the other `windows-125x` code pages, …) throw where Node succeeds. `TextDecoder`'s `options` argument is read as-is; Node additionally `validateObject()`s it, so a scalar `options` is silently ignored here where Node throws `ERR_INVALID_ARG_TYPE`. `decode`/`encodeInto` argument-type errors do match Node exactly (`ERR_INVALID_ARG_TYPE` with Node's message, including the `Received …` tail).

## Web Streams surface

WHATWG Web Streams ([js/internal/streams.js](../pkg/runtime/js/internal/streams.js)) are exposed both as globals and through `require('node:stream/web')` (the global and the module export the same class objects, as in Node). `fetch` builds `response.body` and consumes user-provided request bodies through this same `ReadableStream`, so there is a single stream implementation rather than a fetch-only fork. Verified by `tests/node-compat/cases/25-web-streams.js` (`make test-compat-lava`) and the streaming/`pipeTo`/`pipeThrough` cases in `make test-fetch-smoke`.

**Supported (Node-parity):**

- **`ReadableStream`** (default/chunk source): `new ReadableStream(underlyingSource, strategy)` with `start`/`pull`/`cancel`; `getReader()`, `read()`, `releaseLock()`, `reader.closed`/`cancel()`; `[Symbol.asyncIterator]` / `values()` (with early-break cancellation); `cancel()`, `tee()`, `locked`; `pipeTo()` and `pipeThrough()` (incl. `preventClose`/`preventAbort`/`preventCancel` and an `AbortSignal`); `ReadableStreamDefaultController` with `enqueue`/`close`/`error`/`desiredSize` and `pull`-driven, high-water-mark backpressure.
- **`WritableStream`**: `new WritableStream(underlyingSink, strategy)` with `start`/`write`/`close`/`abort`; `getWriter()`, `write()`, `close()`, `abort()`, `releaseLock()`, `writer.ready`/`closed`/`desiredSize`; `WritableStreamDefaultController.error`. Implemented to the level `pipeTo` needs and generally usable directly.
- **`TransformStream`**: `new TransformStream(transformer, writableStrategy, readableStrategy)` with `start`/`transform`/`flush`; `readable`/`writable`; `TransformStreamDefaultController` `enqueue`/`error`/`terminate`/`desiredSize`; readable↔writable backpressure coupling. The default (no-`transform`) transformer is an identity pass-through, matching Node.
- **Queuing strategies:** `ByteLengthQueuingStrategy` and `CountQueuingStrategy` (`highWaterMark`, `size`).
- **Error/cancellation propagation:** controller `error()`, a throwing `transform`, a failing sink `write`, reader/writer lock violations, and abort-during-`pipeTo` all settle the right side and reject the right promise, matching Node (compared by error constructor; see "intentional differences").

**Deferred (reported explicitly, not silently wrong):**

- **Byte streams / BYOB.** `new ReadableStream({ type: 'bytes' })` throws a clear `TypeError` rather than degrading to a default stream; `stream.getReader({ mode: 'byob' })` throws a `TypeError` (this matches Node for a non-byte stream). `ReadableStreamBYOBReader` exists as a global constructor (so `typeof` matches Node) but constructing one reports the deferral. `ReadableStreamBYOBRequest`/`ReadableByteStreamController` are not exposed. Tracked as a follow-up.

**Intentionally unsupported here:**

- `TextEncoderStream` / `TextDecoderStream`, `CompressionStream` / `DecompressionStream`. (Node provides them via `node:stream/web`; Lava omits them for now — use the buffered `TextEncoder`/`TextDecoder` globals.)

**Intentional differences from Node:**

- Error **messages** carry Lava wording, not Node/undici wording; error **types** (`TypeError`/`RangeError`) and names match. Tests compare by constructor name.
- Web Streams use Promise-based microtask scheduling; fine-grained interleaving of stream microtasks with unrelated work may differ from Node, but per-stream ordering and delivered values do not.
- `node:stream` ↔ Web Stream bridging covers `Readable.toWeb`/`fromWeb` and `Writable.toWeb`/`fromWeb` (probed: a round trip in each direction delivers the chunks); `Duplex.toWeb`/`fromWeb` are absent.

## `Buffer` surface

`Buffer` is a clean-room `Uint8Array` subclass ([js/internal/buffer.js](../pkg/runtime/js/internal/buffer.js)) over Odin codec primitives for the hot paths ([buffer.odin](../pkg/runtime/buffer.odin)). Its own-property API surface matches Node exactly (verified by `make api-surface`). Ported Bun buffer cases live under [tests/node-compat/bun-buffer/ported](../tests/node-compat/bun-buffer/ported) and run via `scripts/report-bun-buffer-tests.sh` (or `make bun-buffer-tests`) and `make test-compat-lava`.

**Supported (Node-parity):**

- **Constructors / statics:** `Buffer.from` (string, `Array`, array-like objects, `ArrayBuffer`/`SharedArrayBuffer` views that _share_ memory, `TypedArray`/`DataView` copies, boxed primitives via `valueOf`/`Symbol.toPrimitive`, and `{type:'Buffer',data:[…]}` JSON revival), `Buffer.alloc`/`allocUnsafe`/`allocUnsafeSlow` (with size validation), `Buffer.of`, `Buffer.concat` (with `list`/element validation), `Buffer.isBuffer`, `Buffer.isEncoding`, `Buffer.byteLength` (string + `ArrayBuffer`/`TypedArray`/`DataView`), `Buffer.compare`, `Buffer.copyBytesFrom`.
- **Deprecated `new Buffer()` constructor:** all forms behave as Node's deprecated constructor does (each delegates to `from`/`alloc`): `new Buffer(size)` is zero-filled like `Buffer.alloc`, `new Buffer(string[, encoding])` encodes like `Buffer.from(string, encoding)`, and `new Buffer(array|buffer|arrayBuffer[, byteOffset[, length]])` mirror the matching `Buffer.from`. (Lava does **not** emit Node's `DEP0005`/`DEP0030` deprecation warnings — it has no `process` deprecation channel — so stderr stays clean.)
- **Instance:** `toString`/slice writers (all encodings), `write`, `slice`/`subarray` (shared-memory views), `copy` (incl. overlapping), `equals`, `compare` (with ranges), `indexOf`/`lastIndexOf`/`includes` (string/number/Buffer needles, encodings, negative offsets), `fill` (number/string/Buffer, regions, encodings), `swap16`/`swap32`/`swap64`, all fixed-width and variable-width `read*`/`write*` integer/float accessors, `readBig*`/`writeBig*` 64-bit, `toJSON`.
- **Offset / value validation (issue #107):** `write`/`fill`/`copy` validate their offset/start/end/`targetStart`/`sourceStart`/`sourceEnd` like Node — a negative or non-integer offset throws `ERR_OUT_OF_RANGE` rather than wrapping from the end. The integer `write*` accessors range-check the value against the writer's min/max (e.g. `writeUInt8(256)`, `writeInt8(128)`, `writeUInt32LE(2**32)`, `writeBigUInt64LE(2n**64n)` all throw `ERR_OUT_OF_RANGE`; a fractional but in-range value is floored, as in Node), and the variable-width `read*`/`write*UIntLE/BE`/`IntLE/BE` require an integer `byteLength` in 1..6 (else `ERR_INVALID_ARG_TYPE`/`ERR_OUT_OF_RANGE`). `fill` rejects an unrepresentable value — a non-empty string that decodes to no bytes (`fill('z','hex')`) or an empty `Buffer` — with `ERR_INVALID_ARG_VALUE`, while the empty string zero-fills.
- **UTF-8 decode (issue #107):** `toString('utf8')` / `Buffer.from(string)` use the Unicode "U+FFFD substitution of maximal subparts" rule (the native Odin decoder, [buffer.odin](../pkg/runtime/buffer.odin)), matching Node/V8: an ill-formed subsequence collapses to a single replacement (`Buffer.from([0xF0,0x9F]).toString()` → `'�'`, not `'��'`). Embedded NUL is preserved.
- **Encodings:** `utf8`/`utf-8`, `utf16le`/`ucs2`, `latin1`/`binary`, `ascii`, `hex`, `base64`, `base64url` (with Node's lenient base64 normalization and `ascii` high-bit masking).
- **Errors:** Node `err.code`s and message shapes for `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE`, `ERR_OUT_OF_RANGE`, `ERR_BUFFER_OUT_OF_BOUNDS`, `ERR_UNKNOWN_ENCODING`, `ERR_INVALID_BUFFER_SIZE`.
- **Rendering:** `util.inspect`/`console.log` emit `<Buffer ..>` (honoring `INSPECT_MAX_BYTES`) via the `nodejs.util.inspect.custom` hook. A Buffer's extra own properties are rendered after the bytes, as in Node: `<Buffer 00 01 02, foo: 'bar'>`. They appear in insertion order with symbol keys last, non-enumerable ones only under `showHidden`, and nested values cut off at `depth`. A direct `buf.inspect(0, {})` renders them too, and a Buffer whose extras lead back to itself ends in Node's `Inspection interrupted prematurely` marker instead of throwing. One deviation: a Buffer **longer than 64 bytes** shows its symbol-keyed extras but not its string-keyed ones. JavaScript cannot list a typed array's named properties without first making one string per index, so without the cap every inspect would cost O(length). At the cap the whole inspect costs about 2.8x the bytes-only render (the measurement and its method are recorded at `INSPECT_EXTRAS_MAX_LENGTH` in [buffer.js](../pkg/runtime/js/internal/buffer.js)). The deviation is pinned by `cmd/lava/buffer_inspect_extras_test.odin`. `colors: true` leaves the extras uncoloured; that is a `util.inspect` gap (#104), not a Buffer one.
- **Module extras:** `Blob`, `File`, `SlowBuffer`, `atob`/`btoa`, `isAscii`, `isUtf8`, `transcode`, `resolveObjectURL`, `kMaxLength`/`kStringMaxLength`/`constants`/`INSPECT_MAX_BYTES`. `Blob`/`File` honor the `endings: 'native'` option (string parts have `\n`/`\r\n` converted to the platform newline — derived from `process.platform` — while a lone `\r` and binary parts are left verbatim, matching Node).

**Intentional differences / deferred:**

- `Buffer.poolSize` allocation pooling is modeled like Node: a per-runtime pool `ArrayBuffer` of `Buffer.poolSize` (262144) bytes serves small _unsafe_ allocations — `Buffer.allocUnsafe(size)`, the `Buffer.from(string|array|typed-array)` copy paths, and `Buffer.concat` — when `size < (Buffer.poolSize >>> 1)` (Node's threshold is strictly less-than, so exactly `poolSize/2` is _not_ pooled), advancing an 8-byte-aligned offset and re-pooling on exhaustion. Such buffers share one backing store at different `byteOffset`s, and `buf.buffer.byteLength` is the pool size rather than the buffer length. `Buffer.alloc` (zero-filled), `Buffer.allocUnsafeSlow`, `SlowBuffer`, and large allocations keep their own right-sized backing store, as in Node. `Buffer.concat` zero-fills any tail an explicit `totalLength` leaves uncovered, so a pooled result never exposes stale pool bytes. The pool is plain per-runtime module state, so it never leaks across isolated runtimes. Pool _offsets_ are not byte-for-byte identical to Node's because Node pre-warms its pool with internal startup allocations; only the relative pooling semantics match, and well-behaved packages must not depend on pool identity anyway.
- `Buffer.poolSize` is a plain data property that stores and returns the raw assigned value (no coercion on read), and the pool's backing store is sized straight from it — matching Node's `new Uint8Array(Buffer.poolSize)`. A fractional `poolSize` is truncated (`8192.7` → `8192`), and a negative or non-finite `poolSize` throws a catchable `RangeError` on the next (re-)pool, rather than the previous `>>> 0`, which wrapped a negative `poolSize` into a multi-gigabyte request and a `>= 2^32` one into a mod-2^32 size (issue #213). A failed re-pool leaves the existing pool intact (the new backing store is committed only on success), so the throw is recoverable. One benign divergence remains: for a `poolSize` large enough to exceed JavaScriptCore's typed-array allocation cap (a few GiB), the (re-)pool throws `RangeError` where Node (whose limit is ~`2^53`) would instead build a multi-gigabyte pool. That is reachable only by deliberately setting `poolSize` to gigabytes _and_ forcing a re-pool, and throwing is the safer behavior — Lava never attempts the giant allocation. Setting `Buffer.poolSize` to any such value is itself unrealistic (the default is 262144 and the threshold still uses Node's `>>> 1` verbatim), so this only hardens the defensive path. The default is **262144**, a deliberate deviation: node 24.22.1 reports 65536, and lava uses a larger slab because a pool refill costs more on JavaScriptCore than on V8 (the reason is recorded at the constant in [buffer.js](../pkg/runtime/js/internal/buffer.js); no measurement is cited there). The value is documented as "may be modified" and well-behaved packages must not depend on it, so a pool-size-dependent observable like `Buffer.from(small).buffer.byteLength` differs from the node24 test oracle — the ported pool tests (`buffer-pool.js`, `buffer-allocunsafe-large.js`, `buffer-poolsize-pathological.js`) are written pool-size-relative so they pass under any pool size. (`kMaxLength` stays the JSC-family 4 GiB.)
- `Buffer.allocUnsafe` (above the pool threshold), `Buffer.allocUnsafeSlow`, and `SlowBuffer` return genuinely **uninitialized** memory like Node: a native allocation (`pkg/runtime/typed_array.odin`) hands JavaScriptCore a non-zero-filled backing store as a NoCopy `Uint8Array`, which the JS layer wraps as a Buffer view. A JS `new ArrayBuffer` is always zero-initialized, so this cannot be done in pure JS; that was the prior divergence (large unsafe allocations came back zero-filled). Such buffers now hold arbitrary prior memory contents — reading a byte before writing it is undefined behavior, as in Node. `Buffer.alloc` remains zero-filled, and the `Buffer.from`/`Buffer.concat` copy paths always overwrite (or zero-fill) every byte, so they never expose stale memory (issue #212). As a safety bound the native uninitialized path serves single allocations up to `2^31 - 1` bytes; a larger unsafe request falls back to a zero-filled own-backing store (JavaScriptCore's NoCopy creator aborts the process past an internal multi-gigabyte limit, whereas the JS allocation throws a catchable `RangeError`). The cap is far above any realistic `allocUnsafe` and keeps behavior identical across Linux, macOS, and Windows.
- **Oversized-allocation ceiling (`kMaxLength`).** Node/V8 advertise `kMaxLength` as `Number.MAX_SAFE_INTEGER` on 64-bit; Lava reports the practical JSC array-buffer limit (**4 GiB on 64-bit, 2 GiB − 1 on 32-bit**), matching **Bun** — the other JSC-based runtime, which likewise reports `kMaxLength === 4294967296` rather than `MAX_SAFE_INTEGER`. It is the JSC-family convention, not a lava-only choice. `Buffer.alloc`/`allocUnsafe`/`allocUnsafeSlow`/`concat` and the `Buffer` constructor enforce this ceiling with Node's coded `ERR_OUT_OF_RANGE` **before** JSC is asked to allocate; negative/`NaN`/non-number sizes are validated and throw first. Raw `new TypedArray(n)` / `new ArrayBuffer(n)` are left to JavaScriptCore, which already throws its own catchable `RangeError` for an over-limit request — exactly as Bun does (Lava does not wrap the global constructors). The Buffer ceiling is overridable with the `LAVA_MAX_BUFFER_BYTES` environment variable (a byte count for operators who want a tighter bound; a non-positive value is ignored). Residual: an allocation handed to JavaScriptCore's **C-API NoCopy creator** from native code with a multi-GiB size — e.g. `fs.readFile` of a file past the limit, where the size comes from the OS rather than a JS constructor — can still abort the process; the JS-layer ceiling covers the JS-constructor and Buffer paths, not native allocations.
- Property-access `TypeError` messages for engine-level faults (e.g. reading a property of `undefined`) carry JavaScriptCore wording, not V8's.

## `process` surface

<!-- BEGIN GENERATED: process -->

**Present (14):** `argv`, `env`, `cwd`, `exit`, `exitCode`, `nextTick`, `pid`, `platform`, `arch`, `version`, `versions`, `memoryUsage`, `stdout`, `stderr`.

**Missing (21):** `hrtime`, `chdir`, `kill`, `resourceUsage`, `uptime`, `stdin`, `execPath`, `argv0`, `execArgv`, `umask`, `on`, `once`, `emit`, `title`, `report`, `ppid`, `release`, `config`, `emitWarning`, `getuid`, `features`.

<!-- END GENERATED: process -->

`process.exitCode` is honored when assigned, but the property does not exist until
then (`'exitCode' in process` is `false`; node predefines it as `undefined`).

## N/A pages (not a JS-API surface)

<!-- BEGIN GENERATED: na -->

| Page | Note |
| --- | --- |
| addons | C++ addon docs |
| cli | eval/run only; CLI flags |
| debugger | — |
| deprecations | catalog |
| documentation | — |
| embedding | C++ embedding |
| errors | some codes used; error catalog |
| index | TOC |
| n-api | C API |
| synopsis | intro |

<!-- END GENERATED: na -->

## Biggest gaps by impact

1. **HTTP client and TLS module** — `node:http` is server-only (`request`/`get`/`Agent` are absent) and the `node:https` client functions are throwing stubs; `fetch` is the only outbound HTTP(S) client. `node:tls`, `http2` and `dgram` are not requireable.
2. **Async `fs`** — 15 mostly synchronous functions; no `node:fs/promises`, streams, `watch`, or async `stat`/`readdir`/`mkdir`.
3. **`process` as an emitter** — no `process.on`/`once`/`emit`, so `process.on('exit')` throws; no `hrtime`, `stdin`, `execPath`.
4. **`crypto` asymmetric/cipher** — hashing, HMAC and the KDFs are real; ciphers, keys, sign/verify, ECDH/DH, X.509, argon2 and `crypto.subtle` are exported stubs that throw.
5. **`dns` resolution** — `lookup` works; every `resolve*`, `reverse` and `lookupService` is a throwing stub.
6. **`zlib`** and the stream classes built on it (`CompressionStream`/`DecompressionStream`).
7. **Concurrency and tooling** — `worker_threads`, `child_process`, `cluster`, `node:test`, `vm` and `readline` are entirely absent.
8. **Web globals** — `atob`/`btoa`, `Event`/`EventTarget`/`CustomEvent`, `FormData`, `DOMException`, `MessageChannel`.
