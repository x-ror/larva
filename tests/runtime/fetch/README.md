# Fetch transport smoke test

Exercises the Odin-backed `fetch` network transport end to end against a real
HTTP origin, comparing Lava's output to Node's.

- `server.js` — a tiny Node origin server (Content-Length, chunked, POST echo,
  large-body, 204, and truncated-body routes).
- `cases.js` — fetch cases run under both Node and Lava; their stdout must match.
  Besides the buffered paths, this covers streaming `response.body` (incremental
  `getReader()` reads and `for await…of`), streaming/`Blob` request bodies,
  single-consumption enforcement, empty (204) bodies, mid-stream cancellation,
  and error propagation on a truncated body. Streaming assertions compare only
  reassembled content (chunk boundaries are transport-defined and differ between
  runtimes).

Run it:

```sh
make test-fetch-smoke
```

This is **not** part of `make test` because it binds a local TCP port, which a
sandboxed CI environment may disallow. The node-compat oracle
(`tests/node-compat/cases/08-fetch.js`) covers the `Headers`/`Request`/`Response`
surface without a network.

The transport handles `http://` and `https://` and resolves DNS off the event loop;
the connect/handshake/write/read path is non-blocking. TLS is OpenSSL on
Linux/Windows and Apple's Security.framework / SecureTransport on macOS (#143). It is
implemented on Linux, macOS, and Windows, though this smoke test only runs on
Linux/macOS — Windows can't yet link/run the binary (no JavaScriptCore on the CI
runner, #36), so Windows HTTPS is codegen-verified only. When the `openssl` CLI is
available the smoke runner generates a self-signed cert and exercises the HTTPS
path, teaching both runtimes to trust it (`NODE_EXTRA_CA_CERTS` for Node,
`SSL_CERT_FILE` for Lava). Note this proves the explicit-CA path, not a platform's
default system trust store.

The explicit-CA HTTPS cases run on **Linux and macOS** (and Windows codegen). Lava
honors `SSL_CERT_FILE` on every platform — OpenSSL loads it on Linux/Windows, and on
macOS the SecureTransport backend loads its certificates as additional trust anchors
(see `pkg/runtime/tls_darwin.odin`). The generated cert carries the `serverAuth`
extended key usage, which Apple's TLS policy requires and OpenSSL accepts too.
