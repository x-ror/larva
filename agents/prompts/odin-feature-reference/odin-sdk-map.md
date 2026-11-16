# Odin SDK map — what already exists

An index for the reuse-first law (`CLAUDE.md` §2). It tells you **where to look**;
it is not a spec. Always read the actual source before committing to a call —
signatures, allocator parameters, error enums, and `when ODIN_OS` coverage change.

```sh
SDK="${ODIN_ROOT:-$(dirname "$(readlink -f "$(command -v odin)")")}"
ls "$SDK/core" "$SDK/vendor"
rg -n 'proc.*<name>' "$SDK/core/<pkg>"
```

Verified against `odin version dev-2026-07`. Packages prefixed with `_`
(`core:crypto/_aes`) are private SDK internals — not public API, do not import.

## Bytes, strings, encodings

| Need                                                | Package                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| UTF-8 encode/decode, rune iteration, validity       | `core:unicode/utf8`                                                                        |
| UTF-16 ↔ UTF-8 (the JSC string bridge)              | `core:unicode/utf16`                                                                       |
| Growable byte buffer, byte search/split/trim        | `core:bytes` (`Buffer`, `Reader`)                                                          |
| String building, split/join/trim/replace, interning | `core:strings` (`Builder`, `Intern`)                                                       |
| Number ↔ string, float formatting/parsing           | `core:strconv`, `core:strconv/decimal`                                                     |
| Base64 / base32 / hex                               | `core:encoding/base64`, `base32`, `hex`                                                    |
| JSON parse/marshal                                  | `core:encoding/json`                                                                       |
| Endian-aware read/write                             | `core:encoding/endian`                                                                     |
| Varint (LEB128)                                     | `core:encoding/varint`                                                                     |
| PEM, ASN.1/DER                                      | `core:encoding/pem`, `core:encoding/asn1`                                                  |
| UUID                                                | `core:encoding/uuid`                                                                       |
| CBOR / CSV / INI / XML                              | `core:encoding/cbor`, `csv`, `ini`, `xml`                                                  |
| HTML entities                                       | `core:encoding/entity`                                                                     |
| Regex                                               | `core:text/regex` (own compiler+VM; **not** JS-regex semantics — JS regexes belong to JSC) |
| Text scanning, matching, editing, tables            | `core:text/scanner`, `text/match`, `text/edit`, `text/table`                               |
| SIMD ops and CPU-feature intrinsics                 | `core:simd`, `core:simd/x86`, `core:simd/arm`                                              |

## Networking

| Need                                 | Package                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| TCP/UDP sockets, addresses, options  | `core:net` (`socket.odin`, `addr.odin`)                                                                                                      |
| DNS resolution without `getaddrinfo` | `core:net` (`dns.odin` — parses `/etc/resolv.conf` + `/etc/hosts`, speaks DNS itself; already used by `pkg/runtime/dns.odin`)                |
| URL split/join/query                 | `core:net/url.odin` (byte-level; WHATWG URL semantics stay in `js/internal/url.js`)                                                          |
| Network interface enumeration        | `core:net` (`interface.odin`)                                                                                                                |
| Async I/O abstraction                | `core:nbio` — read before adding a backend; Lava's own loop already covers the same ground, so treat it as a design reference, not a drop-in |
| io_uring                             | `core:sys/linux/uring` (used by the loop's Linux proactor)                                                                                   |
| kqueue                               | `core:sys/kqueue`                                                                                                                            |
| Raw syscalls                         | `core:sys/linux`, `core:sys/posix`, `core:sys/windows`, `core:sys/darwin`                                                                    |

## Crypto

Never hand-roll a primitive. `core:crypto/*` or OpenSSL (already linked) covers it.

| Need                                               | Package                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| SHA-2 / SHA-3 / SHAKE / BLAKE2 / SM3               | `core:crypto/sha2`, `sha3`, `shake`, `blake2b`, `blake2s`, `sm3`                 |
| Generic hash dispatch by algorithm id              | `core:crypto/hash`                                                               |
| HMAC, HKDF, PBKDF2, Argon2id                       | `core:crypto/hmac`, `hkdf`, `pbkdf2`, `argon2id` (already used by `crypto.odin`) |
| AES, ChaCha20-Poly1305, AEGIS, Deoxys-II           | `core:crypto/aes`, `chacha20poly1305`, `aegis`, `deoxysii`, `aead`               |
| Ed25519 / ECDSA / ECDH / X25519 / X448 / RSA       | `core:crypto/ed25519`, `ecdsa`, `ecdh`, `x25519`, `x448`, `rsa`                  |
| X.509 certificates                                 | `core:crypto/x509`                                                               |
| Constant-time comparison                           | `core:crypto` (`compare_constant_time`)                                          |
| Legacy digests (MD5, SHA-1) needed for Node parity | `core:crypto/legacy`                                                             |
| CSPRNG                                             | `core:crypto` (`rand_bytes`) — not `core:math/rand`, which is not cryptographic  |

TLS itself is OpenSSL via `pkg/runtime/tls.odin`; do not build a TLS stack.

## Data structures, memory, concurrency

| Need                                                  | Package                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Arena / tracking / pool allocators, alignment helpers | `core:mem`                                                                                  |
| Virtual memory arenas                                 | `core:mem/virtual`                                                                          |
| TLSF real-time allocator                              | `core:mem/tlsf`                                                                             |
| LRU cache (module cache, header cache)                | `core:container/lru`                                                                        |
| Priority queue / binary heap                          | `core:container/priority_queue`, `core:slice/heap`                                          |
| Ring buffer / deque                                   | `core:container/queue`                                                                      |
| Fixed-capacity stack array                            | `core:container/small_array`                                                                |
| Bit set over a dynamic range                          | `core:container/bit_array`                                                                  |
| Stable handles into a pool (fd tables, request ids)   | `core:container/handle_map`, `container/pool`                                               |
| Intrusive lists, AVL, red-black                       | `core:container/intrusive`, `avl`, `rbtree`                                                 |
| Sorting, binary search, slice algorithms              | `core:slice`, `core:sort`                                                                   |
| Mutex, RW lock, atomics, once, wait group             | `core:sync`                                                                                 |
| Channels                                              | `core:sync/chan`                                                                            |
| OS threads, thread pool                               | `core:thread` (Lava has its own loop-aware pool in `eventloop/threadpool.odin` — prefer it) |
| Non-crypto hashing                                    | `core:hash`, `core:hash/xxhash`                                                             |

## System, time, files

| Need                              | Package                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| File I/O, dirs, env, process      | `core:os` (`core:os/old` is the legacy API — do not use in new code) |
| Path manipulation                 | `core:path/filepath`, `core:path/slashpath`                          |
| Monotonic + wall clock, durations | `core:time`                                                          |
| Calendar, timezones               | `core:time/datetime`, `core:time/timezone`                           |
| Dynamic library loading           | `core:dynlib`                                                        |
| Terminal detection, ANSI          | `core:terminal`, `core:terminal/ansi`                                |
| gzip / zlib                       | `core:compress/gzip`, `core:compress/zlib`                           |
| CLI flag parsing                  | `core:flags`                                                         |
| Stack traces / symbolication      | `core:debug/trace`                                                   |
| Profiling traces (spall)          | `core:prof/spall`                                                    |
| Reflection over Odin types        | `core:reflect`                                                       |
| Test harness                      | `core:testing`                                                       |
| C interop types                   | `core:c`, `core:c/libc`                                              |

`core:odin/*` (parser, tokenizer, ast, printer) parses **Odin**, not JS — it has no
role in the JS loader or a future TS transform. `core:rexcode` is a machine-code
encoder/decoder for many ISAs; relevant only if Lava ever emits native code.

## The `vendor:` collection

`$SDK/vendor` ships bindings for third-party C libraries — `zlib`, `curl`,
`libc`, `sdl2/3`, `stb`, `lua`, `miniaudio`, `raylib`, `wgpu`, `vulkan`, `x11`,
`windows`, `darwin`, `compress`, `commonmark`, and more. Check it before writing a
`foreign import` block by hand: a maintained binding beats a fresh one.

## Already linked by Lava

Extending one of these costs nothing at build time:

| Library                           | Where                                         |
| --------------------------------- | --------------------------------------------- |
| JavaScriptCore (GTK 6.0 on Linux) | `pkg/jsc/bindings_*.odin`                     |
| OpenSSL (`libssl`/`libcrypto`)    | `pkg/runtime/tls*.odin`                       |
| SQLite3                           | `pkg/std/sqlite`                              |
| libc / POSIX                      | `core:sys/posix`, `foreign import libc`       |
| `picohttpparser` (vendored C)     | `pkg/runtime/picohttpparser`                  |
| `libdl`                           | dynamic symbol lookup for the JSC private ABI |

Before adding a **new** C dependency, state: license, `apt` package and
`pkg-config` name, CI provisioning cost, binary-size impact, and why the SDK and
the libraries above do not work.
