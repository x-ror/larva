#!/usr/bin/env python3
"""Generate the Lava<->Node compatibility matrix from one curated table.

Writes reference/node-compat.json (machine-readable) and the generated sections
of reference/node-compatibility.md (between `<!-- BEGIN GENERATED: x -->` and
`<!-- END GENERATED: x -->` markers), so the two cannot disagree: the page used
to be edited separately and kept marking shipped modules as missing.

The per-module statuses below are curated from probing the built `bin/lava`
(require('node:x'), export-key diff against node, global lookups, calling
exported functions to tell working ones from throwing stubs). After re-probing,
update the table AND the PROBED_* constants, then run:

    python3 scripts/node-compat/gen-matrix.py
"""
import json, os, re

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# What the table below was measured against. Constants, not `git rev-parse HEAD`:
# the script is re-run for wording fixes too, and stamping HEAD then would claim a
# probe that never happened.
PROBED_LAVA_REV = "8e83f8d"
PROBED_DATE = "2026-11-15"
PROBED_NODE = "22.23.4"

# status: full | partial | missing | na  (page -> (status, implemented, gaps))
MODULES = {
    "assert": ("full", "node:assert + assert/strict, AssertionError, partialDeepStrictEqual", "Assert class, CallTracker; deepStrictEqual divergences (#103)"),
    "buffer": ("full", "Buffer/Blob/File/SlowBuffer/isAscii/isUtf8/transcode/resolveObjectURL; module-level atob/btoa (+ global URL.createObjectURL/revokeObjectURL)", "atob/btoa are not installed as globals (#86)"),
    "events": ("full", "EventEmitter, once, on, getEventListeners, getMaxListeners, setMaxListeners, listenerCount, addAbortListener, defaultMaxListeners", "EventEmitterAsyncResource/errorMonitor/captureRejections; no EventTarget/CustomEvent globals; meta-events (#105)"),
    "intl": ("full", "engine (JavaScriptCore) Intl", "engine-provided, not lava code"),
    "path": ("full", "posix+win32 full surface", ""),
    "sqlite": ("full", "DatabaseSync/StatementSync", "backup/constants/session"),
    "console": ("partial", "global console + node:console module with a Console class", "context/createTask/profile/profileEnd/timeStamp; Console ignores its stdout/stderr streams (#104)"),
    "crypto": ("partial", "19 working: createHash/createHmac/hash/Hash/Hmac/getHashes/hkdf(Sync)/pbkdf2(Sync)/scrypt(Sync)/randomBytes/randomFill(Sync)/randomInt/randomUUID/timingSafeEqual/getFips", "47 exported stubs that throw: ciphers/KeyObject/sign/verify/X509Certificate/ECDH/DH/KEM/argon2/primes/generateKey*/setFips/randomUUIDv7"),
    "esm": ("partial", ".mjs transform, import works", "loader hooks/register"),
    "fs": ("partial", "15 fns: readFile/readFileSync/writeFile/writeFileSync/openSync/closeSync/existsSync/mkdirSync/mkdtempSync/rmSync/rmdirSync/unlinkSync/renameSync/statSync/readdirSync; reads return Buffer and honor the encoding (JS layer, #330)", "no node:fs/promises, streams, watch, copyFile/access/chmod, async stat/readdir/mkdir, constants (#84)"),
    "globals": ("partial", "40 globals present (see globals.present)", "atob/btoa, Event/EventTarget/CustomEvent, FormData, DOMException, MessageChannel, navigator, reportError, WebSocket, byte/compression/text streams"),
    "module": ("partial", "CommonJS require + node: resolution", "node:module is not requireable: createRequire/register/isBuiltin/SourceMap"),
    "modules": ("partial", "CommonJS require", "same as module"),
    "packages": ("partial", "package.json resolution (partial)", "exports/imports map edge cases"),
    "perf_hooks": ("partial", "global performance.now/timeOrigin", "node:perf_hooks is not requireable; PerformanceObserver/marks/entries"),
    "process": ("partial", "argv/env/cwd/exit/exitCode/nextTick/pid/platform/arch/version(s)/memoryUsage/stdout/stderr; node:process requireable", "hrtime/on/once/emit/stdin/kill/chdir/uptime/execPath/argv0/execArgv/umask/title/emitWarning (#355, #86); exitCode is honored when set but is not a predefined property"),
    "timers": ("partial", "global timers + node:timers + node:timers/promises", "timers return a number, not a Timeout: no ref/unref/refresh (#85)"),
    "url": ("full", "WHATWG URL + URLSearchParams (global and module); fileURLToPath/pathToFileURL/urlToHttpOptions/format/domainToASCII/domainToUnicode", "legacy url.parse/resolve/Url; IDNA approximated (NFKC+Punycode, not full ICU UTS-46)"),
    "util": ("partial", "inspect/format/formatWithOptions/promisify/callbackify/inherits/deprecate/isDeepStrictEqual/debuglog/aborted/parseArgs/parseEnv/MIMEType/MIMEParams/styleText/stripVTControlCharacters/toUSVString/types", "TextEncoder/TextDecoder re-exports, diff, getCallSites, getSystemErrorName/Message/Map, transferableAbort*; inspect caps (#331)"),
    "webcrypto": ("partial", "crypto.getRandomValues/randomUUID", "crypto.subtle (all SubtleCrypto)"),
    "environment_variables": ("partial", "some env honored", ""),
    "async_context": ("missing", "", "AsyncLocalStorage"),
    "async_hooks": ("missing", "", ""),
    "child_process": ("missing", "", ""),
    "cluster": ("missing", "", ""),
    "dgram": ("missing", "", ""),
    "diagnostics_channel": ("full", "channel/hasSubscribers/subscribe/unsubscribe/tracingChannel/Channel (all 6 exports)", ""),
    "dns": ("partial", "lookup + dns/promises lookup (thread pool), constants and error codes", "17 exported stubs that throw: resolve*/reverse/lookupService/getServers/setServers (#179); dns/promises lacks the error-code constants"),
    "domain": ("missing", "", "deprecated upstream"),
    "dtls": ("missing", "", ""),
    "ffi": ("missing", "", ""),
    "http": ("partial", "server: createServer/Server/IncomingMessage/ServerResponse/STATUS_CODES", "no client (request/get/Agent/ClientRequest/globalAgent), METHODS, maxHeaderSize, validateHeaderName/Value (#81)"),
    "http2": ("missing", "", ""),
    "https": ("partial", "server: createServer/Server over the native TLS server", "request/get/Agent are exported stubs that throw — the HTTPS client is fetch (#81)"),
    "inspector": ("missing", "", ""),
    "net": ("partial", "createServer/Server/Socket/connect/createConnection (TCP)", "isIP/isIPv4/isIPv6, BlockList, SocketAddress, autoSelectFamily controls"),
    "os": ("full", "all 23 exports present", ""),
    "permissions": ("missing", "", ""),
    "punycode": ("full", "all 6 exports present", "deprecated upstream"),
    "querystring": ("full", "parse/stringify/escape/unescape/decode/encode", "unescapeBuffer"),
    "quic": ("missing", "", ""),
    "readline": ("missing", "", ""),
    "repl": ("missing", "", ""),
    "report": ("missing", "", ""),
    "single-executable-applications": ("missing", "", "tooling"),
    "stream": ("partial", "Stream/Readable/Writable/Duplex/Transform/PassThrough/finished/pipeline/addAbortSignal/isReadable/isWritable + node:stream/promises; Readable/Writable toWeb/fromWeb", "compose/duplexPair/destroy/isErrored/isDisturbed/isDestroyed/get|setDefaultHighWaterMark/stream.promises; Duplex.toWeb/fromWeb; no node:stream/consumers"),
    "stream_iter": ("missing", "", ""),
    "string_decoder": ("full", "StringDecoder", ""),
    "test": ("missing", "", ""),
    "tls": ("missing", "TLS is used internally by fetch and https.createServer", "node:tls is not requireable"),
    "tracing": ("missing", "", "trace_events"),
    "tty": ("partial", "isatty/ReadStream/WriteStream", "getWindowSize reports a fixed 80x24 (#355)"),
    "typescript": ("missing", "", "no type stripping"),
    "v8": ("missing", "", ""),
    "vfs": ("missing", "", ""),
    "vm": ("missing", "", ""),
    "wasi": ("missing", "", "WebAssembly present, WASI glue absent"),
    "webstreams": ("partial", "ReadableStream/WritableStream/TransformStream globals + node:stream/web; readers/writers/controllers; pipeTo/pipeThrough; backs response.body", "byte streams/BYOB request+controller, TextEncoderStream/TextDecoderStream, CompressionStream/DecompressionStream (#214)"),
    "worker_threads": ("missing", "", ""),
    "zlib": ("missing", "", ""),
    "addons": ("na", "", "C++ addon docs"),
    "cli": ("na", "eval/run only", "CLI flags"),
    "debugger": ("na", "", ""),
    "deprecations": ("na", "", "catalog"),
    "documentation": ("na", "", ""),
    "embedding": ("na", "", "C++ embedding"),
    "errors": ("na", "some codes used", "error catalog"),
    "index": ("na", "", "TOC"),
    "n-api": ("na", "", "C API"),
    "synopsis": ("na", "", "intro"),
}

GLOBALS_PRESENT = ["global", "globalThis", "Buffer", "fetch", "Headers", "Request", "Response", "TextEncoder", "TextDecoder", "AbortController", "AbortSignal", "structuredClone", "queueMicrotask", "setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "clearImmediate", "console", "process", "performance", "Blob", "File", "crypto", "URL", "URLSearchParams", "ReadableStream", "WritableStream", "TransformStream", "ReadableStreamDefaultReader", "ReadableStreamBYOBReader", "ReadableStreamDefaultController", "WritableStreamDefaultWriter", "WritableStreamDefaultController", "TransformStreamDefaultController", "ByteLengthQueuingStrategy", "CountQueuingStrategy", "WebAssembly", "Intl"]
GLOBALS_MISSING = ["atob", "btoa", "Event", "EventTarget", "CustomEvent", "FormData", "DOMException", "ReadableStreamBYOBRequest", "ReadableByteStreamController", "TextEncoderStream", "TextDecoderStream", "CompressionStream", "DecompressionStream", "MessageChannel", "MessagePort", "Worker", "BroadcastChannel", "WebSocket", "PerformanceObserver", "navigator", "reportError", "crypto.subtle"]
PROCESS_PRESENT = ["argv", "env", "cwd", "exit", "exitCode", "nextTick", "pid", "platform", "arch", "version", "versions", "memoryUsage", "stdout", "stderr"]
PROCESS_MISSING = ["hrtime", "chdir", "kill", "resourceUsage", "uptime", "stdin", "execPath", "argv0", "execArgv", "umask", "on", "once", "emit", "title", "report", "ppid", "release", "config", "emitWarning", "getuid", "features"]


# Pages whose status is not "missing" but which are not a requireable `node:` module:
# either the page documents no module, or the surface exists only as globals.
NOT_REQUIREABLE = {"environment_variables", "esm", "globals", "intl", "module", "modules", "packages", "perf_hooks", "webcrypto"}
# Pages requireable under another specifier than `node:<page>`.
REQUIRE_AS = {"webstreams": "node:stream/web"}

ICON = {"full": "✅", "partial": "🟡", "missing": "🟥", "na": "⚪"}


def code_list(names):
    return ", ".join("`%s`" % n for n in names)


def cell(text):
    return text.replace("|", "\\|").replace("*", "\\*") if text else "—"


def render_sections(counts):
    by = {st: sorted(n for n, (s, _, _) in MODULES.items() if s == st) for st in ICON}
    label = {"full": "Full", "partial": "Partial", "missing": "Missing", "na": "N/A"}
    score = ["| Status | Count | Pages |", "| --- | ---: | --- |"]
    for st in ("full", "partial", "missing", "na"):
        score.append("| %s %s | %d | %s |" % (ICON[st], label[st], counts[st], ", ".join(by[st])))
    mods = ["| Page | `require` | Status | Implemented | Gaps |", "| --- | :---: | :---: | --- | --- |"]
    for name, (st, have, gaps) in sorted(MODULES.items()):
        if st == "na":
            continue
        if st == "missing" or name in NOT_REQUIREABLE:
            req = "❌"
        else:
            req = "`%s`" % REQUIRE_AS.get(name, "node:" + name)
        mods.append("| **%s** | %s | %s | %s | %s |" % (name, req, ICON[st], cell(have), cell(gaps)))
    na = ["| Page | Note |", "| --- | --- |"]
    for name in by["na"]:
        _, have, gaps = MODULES[name]
        na.append("| %s | %s |" % (name, cell("; ".join(x for x in (have, gaps) if x))))
    return {
        "provenance": "- **lava revision measured:** `%s` (%s), export keys diffed against node %s."
        % (PROBED_LAVA_REV, PROBED_DATE, PROBED_NODE),
        "scoreboard": "\n".join(score),
        "modules": "\n".join(mods),
        "globals": "**Present (%d):** %s.\n\n**Missing (%d):** %s."
        % (len(GLOBALS_PRESENT), code_list(GLOBALS_PRESENT), len(GLOBALS_MISSING), code_list(GLOBALS_MISSING)),
        "process": "**Present (%d):** %s.\n\n**Missing (%d):** %s."
        % (len(PROCESS_PRESENT), code_list(PROCESS_PRESENT), len(PROCESS_MISSING), code_list(PROCESS_MISSING)),
        "na": "\n".join(na),
    }


def write_markdown(counts):
    path = os.path.join(REPO_ROOT, "reference", "node-compatibility.md")
    text = open(path, encoding="utf-8").read()
    for key, body in render_sections(counts).items():
        pat = re.compile(
            r"(<!-- BEGIN GENERATED: %s -->\n).*?(\n<!-- END GENERATED: %s -->)" % (key, key), re.S
        )
        text, n = pat.subn(lambda m: m.group(1) + "\n" + body + "\n" + m.group(2), text)
        if n != 1:
            raise SystemExit("node-compatibility.md: expected exactly one GENERATED block %r, found %d" % (key, n))
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote", path)


def node_sha():
    src = os.path.join(REPO_ROOT, "reference", "node-doc-api", "SOURCE.txt")
    if os.path.exists(src):
        for line in open(src):
            if line.startswith("Node main commit:"):
                return line.split(":", 1)[1].strip()
    return ""


def main():
    counts = {"full": 0, "partial": 0, "missing": 0, "na": 0}
    rows = []
    for name, (status, have, gaps) in sorted(MODULES.items()):
        counts[status] += 1
        rows.append({"page": name, "status": status, "implemented": have, "gaps": gaps})

    out = {
        "generated_against": {
            "lava_rev": PROBED_LAVA_REV,
            "node_doc_sha": node_sha(),
            "node_doc_pages": len(MODULES),
        },
        "legend": {
            "full": "implemented (substantial)",
            "partial": "core works, notable gaps/stubs",
            "missing": "require throws MODULE_NOT_FOUND",
            "na": "not a JS-API surface",
        },
        "counts": counts,
        "modules": rows,
        "globals": {"present": GLOBALS_PRESENT, "missing": GLOBALS_MISSING},
        "process": {"present": PROCESS_PRESENT, "missing": PROCESS_MISSING},
    }
    dest = os.path.join(REPO_ROOT, "reference", "node-compat.json")
    with open(dest, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    print("counts:", counts, "total:", sum(counts.values()))
    print("wrote", dest)
    write_markdown(counts)


if __name__ == "__main__":
    main()
