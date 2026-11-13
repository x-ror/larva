// Fetch transport smoke cases. Run under both Node and Lava against the sibling
// server.js; the two outputs must match exactly (see scripts/run-fetch-smoke.sh).
// FETCH_BASE points at the running origin, e.g. http://127.0.0.1:8799
const assert = require('node:assert/strict');

const base = process.env.FETCH_BASE;

async function main() {
  assert.equal(typeof fetch, 'function');

  // GET, Content-Length framing, text()
  const r1 = await fetch(base + '/hello.txt');
  assert.equal(r1.status, 200);
  assert.equal(r1.ok, true);
  console.log('hello.txt:', JSON.stringify(await r1.text()));

  // GET, json() + a response header
  const r2 = await fetch(base + '/data.json');
  console.log('data.json:', JSON.stringify(await r2.json()));
  console.log('content-type:', r2.headers.get('content-type'));

  // 404 still resolves with ok=false
  const r3 = await fetch(base + '/nope-not-here');
  console.log('missing ok/status:', r3.ok, r3.status);

  // Multi-byte UTF-8 response must decode correctly (not latin1 mojibake)
  const ru = await fetch(base + '/utf8');
  console.log('utf8:', JSON.stringify(await ru.text()));

  // POST with a JSON body, chunked response
  const r4 = await fetch(base + '/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 1, y: 'two' }),
  });
  const echoed = await r4.json();
  console.log('POST:', echoed.method, echoed.echo, echoed.len);

  // UTF-8 request body round-trips byte-exact through the transport
  const rb = await fetch(base + '/echo', { method: 'POST', body: 'héllo café ☕' });
  const back = await rb.json();
  console.log('POST utf8 echo:', JSON.stringify(back.echo));

  // invalid JSON rejects (json() must not throw synchronously)
  let jsonRejected = false;
  const rt = await fetch(base + '/hello.txt');
  await rt.json().catch(() => {
    jsonRejected = true;
  });
  console.log('bad json rejected:', jsonRejected);

  // A timer co-pending with an in-flight fetch must neither hang the request
  // (regression: io_uring re-arm submission) nor be dropped (regression: loop
  // clock advance + 1ms timer floor so a 0ms interval cannot starve the poll).
  const iv = setInterval(() => {}, 0);
  const timed = [];
  setTimeout(() => timed.push('timeout'), 5);
  const tr = await fetch(base + '/a').then((r) => r.text());
  clearInterval(iv);
  await new Promise((resolve) => setTimeout(resolve, 25));
  console.log('timer+fetch:', tr === 'AAA', timed.includes('timeout'));

  // Three concurrent requests resolve in Promise.all order
  const [a, b, c] = await Promise.all([
    fetch(base + '/a').then((r) => r.text()),
    fetch(base + '/b').then((r) => r.text()),
    fetch(base + '/c').then((r) => r.text()),
  ]);
  console.log('concurrent:', a, b, c);

  // --- Streaming response/request bodies (issue #31) ---
  // The large bodies below cross the response-body backpressure high-water mark,
  // so they exercise the pause/resume path. Chunk boundaries are transport
  // defined, so the assertions only compare reassembled content, never chunk
  // counts or sizes (which legitimately differ between Node and Lava).
  const BIG = 'x'.repeat(200000);
  const BIG_CL = 'y'.repeat(200000);

  // response.body.getReader(): incremental reads reassemble to the full body.
  {
    const r = await fetch(base + '/big');
    assert.equal(r.body.locked, false);
    const reader = r.body.getReader();
    assert.equal(r.body.locked, true);
    const dec = new TextDecoder();
    let out = '';
    let first = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first === null) first = value instanceof Uint8Array;
      out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
    console.log('stream getReader:', first, out === BIG, r.bodyUsed);
  }

  // Content-Length-framed large body streams the same way.
  {
    let total = 0;
    for await (const chunk of (await fetch(base + '/big-cl')).body) total += chunk.length;
    console.log('stream asyncIterator:', total === BIG_CL.length);
  }

  // Buffered APIs still work over the streaming transport: text() drains the
  // stream, json()/arrayBuffer() too.
  {
    const t = await (await fetch(base + '/big')).text();
    console.log('buffered text after stream:', t.length === BIG.length, t === BIG);
    const ab = await (await fetch(base + '/data.json')).arrayBuffer();
    console.log('buffered arrayBuffer:', ab.byteLength, ab instanceof ArrayBuffer);
  }

  // --- Streaming request bodies (issue #182): true chunked upload ---
  // A ReadableStream / async-iterable body is streamed incrementally as
  // Transfer-Encoding: chunked (never materialized); a string/Buffer/Blob body
  // keeps the buffered Content-Length fast path. Node and Lava frame these
  // identically, so the server's echoed `te`/`cl` must match across both.

  // An async-generator body streams chunked: byte-exact echo, te=chunked, no cl.
  {
    async function* gen() {
      yield new TextEncoder().encode('strm-');
      yield new TextEncoder().encode('body');
    }
    const rq = await fetch(base + '/echo', { method: 'POST', body: gen(), duplex: 'half' });
    const j = await rq.json();
    console.log('request stream echo:', JSON.stringify(j.echo), j.len);
    console.log('request stream framing:', j.te, j.cl);
  }

  // A ReadableStream body streams the same way. The source is another response's
  // body (a real ReadableStream in both Node and Lava — the standalone
  // ReadableStream global is not exposed in Lava), piped straight into the upload.
  {
    const src = (await fetch(base + '/a')).body;
    const j = await fetch(base + '/echo', { method: 'POST', body: src, duplex: 'half' }).then((r) =>
      r.json(),
    );
    console.log('request ReadableStream:', JSON.stringify(j.echo), j.te, j.cl);
  }

  // A buffered string body keeps the Content-Length fast path: cl set, no te.
  {
    const j = await fetch(base + '/echo', { method: 'POST', body: 'buffered-string' }).then((r) =>
      r.json(),
    );
    console.log('buffered string framing:', JSON.stringify(j.echo), j.te, j.cl);
  }

  // A Blob body is a known-length body — buffered with Content-Length (no duplex
  // required), not chunked.
  {
    const j = await fetch(base + '/echo', {
      method: 'POST',
      body: new Blob(['blob ', 'data']),
    }).then((r) => r.json());
    console.log('request blob echo:', JSON.stringify(j.echo), j.te, j.cl);
  }

  // A large streamed body crosses the socket write buffer many times, exercising
  // the write-backpressure pause/resume path. Only the reassembled content is
  // compared (chunk boundaries are transport-defined).
  {
    const PART = 'z'.repeat(8192);
    async function* big() {
      for (let i = 0; i < 30; i++) yield new TextEncoder().encode(PART);
    }
    const j = await fetch(base + '/echo', { method: 'POST', body: big(), duplex: 'half' }).then(
      (r) => r.json(),
    );
    console.log('large stream upload:', j.len === 30 * PART.length, j.te);
  }

  // A single chunk larger than the socket send buffer forces a mid-frame partial
  // write (body_out_off walking one frame across several writable events), distinct
  // from the many-small-chunks backpressure above.
  {
    const ONE = 'q'.repeat(1 << 20); // 1 MiB in a single chunk
    async function* oneBig() {
      yield new TextEncoder().encode(ONE);
    }
    const j = await fetch(base + '/echo', { method: 'POST', body: oneBig(), duplex: 'half' }).then(
      (r) => r.json(),
    );
    console.log('single large chunk:', j.len === ONE.length, j.te);
  }

  // An empty streamed body delivers an empty request body. (Framing is NOT
  // asserted: Node sends Content-Length: 0 for an immediately-empty producer,
  // while Lava sends an empty chunked body — terminator only; the received body is
  // identical either way.)
  {
    async function* empty() {}
    const j = await fetch(base + '/echo', { method: 'POST', body: empty(), duplex: 'half' }).then(
      (r) => r.json(),
    );
    console.log('empty stream upload:', JSON.stringify(j.echo), j.len);
  }

  // A streaming body still requires duplex:'half' (matching Node) — omitting it
  // throws a TypeError at fetch() time.
  {
    async function* gen() {
      yield new TextEncoder().encode('x');
    }
    let dup = '';
    try {
      await fetch(base + '/echo', { method: 'POST', body: gen() });
    } catch (error) {
      dup = error && error.constructor.name;
    }
    console.log('stream needs duplex:', dup);
  }

  // A producer that throws mid-stream aborts the request: the fetch rejects.
  {
    async function* boom() {
      yield new TextEncoder().encode('before-');
      throw new Error('producer kaboom');
    }
    let failed = false;
    try {
      await fetch(base + '/echo', { method: 'POST', body: boom(), duplex: 'half' });
    } catch {
      failed = true;
    }
    console.log('producer error aborts:', failed);
  }

  // Aborting an in-flight upload (a slow producer that stalls before finishing)
  // rejects with an AbortError. The producer never completes on its own, so the
  // abort — not EOF — ends the upload.
  {
    const ac = new AbortController();
    async function* slow() {
      yield new TextEncoder().encode('first-chunk');
      // Stall long enough for the abort below to fire mid-upload.
      await new Promise((resolve) => setTimeout(resolve, 200));
      yield new TextEncoder().encode('never-sent');
    }
    setTimeout(() => ac.abort(), 20);
    let name = '';
    try {
      await fetch(base + '/echo', {
        method: 'POST',
        body: slow(),
        duplex: 'half',
        signal: ac.signal,
      });
    } catch (error) {
      name = error && error.name;
    }
    console.log('abort in-flight upload:', name);
  }

  // A streamed upload over Connection: close still completes (Lava always sends
  // Connection: close; the chunked terminator delimits the body regardless).
  {
    async function* gen() {
      yield new TextEncoder().encode('conn-');
      yield new TextEncoder().encode('close');
    }
    const j = await fetch(base + '/echo', { method: 'POST', body: gen(), duplex: 'half' }).then(
      (r) => r.json(),
    );
    console.log('stream over conn-close:', JSON.stringify(j.echo), j.te);
  }

  // --- Public Web Streams over a real response/request body (issue #184) ---
  // A user-created ReadableStream (the standard global) is accepted as a request
  // body, the same as the internal stream that backs response.body.
  {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('rs-'));
        c.enqueue(new TextEncoder().encode('global-body'));
        c.close();
      },
    });
    const echoed = await fetch(base + '/echo', { method: 'POST', body, duplex: 'half' }).then((r) =>
      r.json(),
    );
    console.log('readablestream request body:', JSON.stringify(echoed.echo), echoed.len);
  }

  // Aborting while a streaming request body is still being collected — a stalled
  // producer whose read() never resolves — must reject promptly with the signal's
  // AbortError rather than hang waiting for a chunk that never comes. (Regression:
  // collectStreamBody only checked signal.aborted between reads, so an abort
  // landing during a pending read could not wake it and fetch hung before the
  // transport even started.)
  {
    const ac = new AbortController();
    const body = new ReadableStream({
      pull() {
        return new Promise(() => {}); // never produces a chunk
      },
    });
    setTimeout(() => ac.abort(), 10);
    let name = '';
    try {
      await fetch(base + '/echo', { method: 'POST', body, duplex: 'half', signal: ac.signal });
    } catch (error) {
      name = error && error.name;
    }
    console.log('abort streaming upload:', name);
  }

  // response.body.pipeTo(WritableStream): the sink reassembles the full body and
  // the body ends up consumed (locked → used). Chunk sizes are transport-defined,
  // so only the reassembled length is compared, never chunk counts.
  {
    const r = await fetch(base + '/big');
    let total = 0;
    const sink = new WritableStream({
      write(chunk) {
        total += chunk.length;
      },
    });
    await r.body.pipeTo(sink);
    console.log('response pipeTo:', total === BIG.length, r.bodyUsed);
  }

  // response.body.pipeThrough(TransformStream): an identity transform passes the
  // streamed bytes through; the drained total matches the body length.
  {
    const r = await fetch(base + '/big-cl');
    let total = 0;
    for await (const chunk of r.body.pipeThrough(new TransformStream())) total += chunk.length;
    console.log('response pipeThrough:', total === BIG_CL.length);
  }

  // A body can be consumed only once; a second attempt rejects with a TypeError.
  {
    const r = await fetch(base + '/a');
    const t1 = await r.text();
    let secondErr = '';
    try {
      await r.text();
    } catch (error) {
      secondErr = error && error.constructor.name;
    }
    console.log('double consume:', t1, secondErr);

    // Once a reader is acquired the body is locked; buffered reads then reject.
    const rl = await fetch(base + '/a');
    const rd = rl.body.getReader();
    let lockedErr = '';
    try {
      await rl.text();
    } catch (error) {
      lockedErr = error && error.constructor.name;
    }
    console.log('locked body:', rl.body.locked, lockedErr);
    await rd.cancel();
  }

  // Empty body: a 204 response exposes a null body (no stream).
  {
    const r = await fetch(base + '/empty');
    console.log('empty body:', r.body === null, r.status);
  }

  // Cancellation / early close: cancelling the reader mid-stream tears the
  // transport down; the body is then marked used and further reads report done.
  {
    const r = await fetch(base + '/big');
    const reader = r.body.getReader();
    await reader.read();
    await reader.cancel();
    const after = await reader.read();
    console.log('cancel mid-stream:', r.bodyUsed, after.done);
  }

  // Error propagation during streaming: a truncated body (declared length not
  // met before the connection drops) rejects the body read with a TypeError,
  // after the response head has already resolved.
  {
    const r = await fetch(base + '/truncate');
    let streamErr = '';
    try {
      await r.text();
    } catch (error) {
      streamErr = error && error.constructor.name;
    }
    console.log('truncated stream:', r.status, streamErr);
  }

  // Malformed chunked framing (chunk data not followed by CRLF) must reject the
  // body read, not be accepted as valid bytes.
  {
    const r = await fetch(base + '/badchunk');
    let err = '';
    try {
      await r.text();
    } catch (error) {
      err = error && error.constructor.name;
    }
    console.log('malformed chunk:', r.status, err);
  }

  // Abort AFTER the response head has resolved must still tear the body down: the
  // in-flight body read rejects with the signal's AbortError. /slowbody sends one
  // chunk then stalls, so the abort — not EOF — ends the read.
  {
    const ac = new AbortController();
    const r = await fetch(base + '/slowbody', { signal: ac.signal });
    const reader = r.body.getReader();
    await reader.read(); // first chunk ('partial')
    ac.abort();
    let name = '';
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (error) {
      name = error && error.name;
    }
    console.log('abort after headers:', name);
  }

  // fetch(new Request(url, { body: <stream>, duplex: 'half' })) — the streaming
  // body must survive Request construction and reach the server (not be dropped).
  {
    async function* gen() {
      yield new TextEncoder().encode('req-');
      yield new TextEncoder().encode('obj-body');
    }
    const rq = new Request(base + '/echo', { method: 'POST', body: gen(), duplex: 'half' });
    const echoed = await fetch(rq).then((r) => r.json());
    console.log('request-object stream body:', JSON.stringify(echoed.echo));
  }

  // clone() tees a streaming body: both responses read the full content.
  {
    const r = await fetch(base + '/big');
    const r2 = r.clone();
    const [t1, t2] = await Promise.all([r.text(), r2.text()]);
    console.log('clone tee:', t1.length === BIG.length, t1 === t2);
  }

  // --- Stale-poll cancellation regression (issue #183) ---
  // Cancelling a streaming reader mid-body settles the request and frees its
  // backing memory; the very next fetch reuses that memory. On the io_uring
  // backend a stale poll completion landing on the reused request was a
  // use-after-free. Looping cancel→refetch many times must stay clean — each body
  // is marked used and the run completes without corruption.
  {
    let clean = true;
    for (let i = 0; i < 12; i++) {
      const r = await fetch(base + '/big');
      const reader = r.body.getReader();
      await reader.read(); // pull one chunk — a socket poll is outstanding here
      await reader.cancel(); // settle + free mid-stream, with that poll still live
      if (!r.bodyUsed) clean = false;
    }
    console.log('cancel churn clean:', clean);
  }

  // Backpressure resume racing body completion: yielding to a macrotask between
  // reads invites the transport to pause and resume the socket read repeatedly, so
  // the final chunk can arrive while a resume drive is still queued. The
  // reassembled body must still be byte-exact and the stream must end cleanly.
  {
    const r = await fetch(base + '/big');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    out += dec.decode();
    console.log('slow-drain stream:', out.length === BIG.length, out === BIG);
  }

  // Abort mid-stream then immediately re-fetch and fully drain: the aborted
  // request frees while its poll may still be outstanding, and the next request
  // must read its body intact (not inherit a stale completion).
  {
    const ac = new AbortController();
    const r = await fetch(base + '/big', { signal: ac.signal });
    const reader = r.body.getReader();
    await reader.read();
    ac.abort();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // aborted read rejects — expected
    }
    const fresh = await (await fetch(base + '/big')).text();
    console.log('abort then refetch:', fresh.length === BIG.length, fresh === BIG);
  }

  // Concurrent streaming fetches where one reader's continuation cancels a sibling
  // mid-flight and immediately starts another fetch. On Lava the microtask
  // checkpoint runs inside the watcher dispatch, so this continuation executes while
  // the poll batch is still being walked; freeing the cancelled sibling before its
  // own readiness entry in that batch is dispatched was a use-after-free on the
  // pointer-based backends (kqueue/select, or epoll without io_uring) — the
  // generation-token io_uring backend was already safe. The run must stay clean and
  // every third body must be byte-exact (#183 / #198).
  {
    let clean = true;
    for (let i = 0; i < 10; i++) {
      const ra = await fetch(base + '/big');
      const rb = await fetch(base + '/big');
      const readerA = ra.body.getReader();
      const readerB = rb.body.getReader();
      // Prime B so its socket readiness can land in the same poll batch as A's.
      const pendingB = readerB.read().catch(() => {});
      await readerA.read();
      // Runs mid-batch on Lava: cancel() runs B's cancel steps synchronously
      // (settling + queueing B's free), then a fresh fetch() whose reclaim would free
      // B — while B's own batch entry may still be pending behind A's.
      const pendingCancelB = readerB.cancel();
      const c = await (await fetch(base + '/big')).text();
      if (c !== BIG) clean = false;
      await pendingCancelB.catch(() => {});
      await pendingB;
      await readerA.cancel();
    }
    console.log('concurrent cancel+refetch clean:', clean);
  }

  // --- HTTP correctness (issue #99) ---

  // HEAD with a Content-Length echo: a conforming server replies to HEAD with the
  // GET's Content-Length and an empty body. The response must parse (status 200,
  // header present) and expose a null body — not be rejected as malformed.
  {
    const r = await fetch(base + '/data.json', { method: 'HEAD' });
    const body = await r.text();
    console.log(
      'HEAD:',
      r.status,
      r.headers.get('content-length') !== null,
      body === '',
      r.body === null,
    );
  }

  // Redirect following (default redirect: 'follow'): a 302 is chased to its
  // target; the final response carries the destination body and redirected=true,
  // and its url is the destination.
  {
    const r = await fetch(base + '/redirect');
    console.log('redirect follow:', r.status, await r.text(), r.redirected, r.url.endsWith('/a'));
  }

  // clone() preserves redirected metadata: a clone of a followed-redirect response
  // is still redirected=true (the constructor would otherwise reset it to false).
  {
    const r = await fetch(base + '/redirect');
    const c = r.clone();
    console.log('redirect clone redirected:', r.redirected, c.redirected);
    await r.text();
    await c.text();
  }

  // A relative Location is resolved against the request URL.
  {
    const r = await fetch(base + '/redirect-rel');
    console.log('redirect relative:', r.status, await r.text(), r.url.endsWith('/a'));
  }

  // 303 turns a POST into a GET and drops the body: the destination sees a GET.
  {
    const r = await fetch(base + '/redirect-303', { method: 'POST', body: 'discard-me' });
    console.log('redirect 303 POST->GET:', r.status, await r.text(), r.redirected);
  }

  // 307 preserves the method and resends the body: the echo reports POST + body.
  {
    const r = await fetch(base + '/redirect-307', { method: 'POST', body: 'keep-me' });
    const j = await r.json();
    console.log('redirect 307 keeps body:', j.method, JSON.stringify(j.echo), r.redirected);
  }

  // 307 also resends a Blob body: a Blob is replayable (known length), so the
  // upload survives the redirect rather than failing as a streaming body would.
  {
    const r = await fetch(base + '/redirect-307', {
      method: 'POST',
      body: new Blob(['blob ', 'payload']),
    });
    const j = await r.json();
    console.log('redirect 307 keeps blob:', j.method, JSON.stringify(j.echo), r.redirected);
  }

  // redirect: 'manual' returns the 3xx response untouched (status, Location, body).
  {
    const r = await fetch(base + '/redirect', { redirect: 'manual' });
    console.log(
      'redirect manual:',
      r.status,
      r.headers.get('location'),
      await r.text(),
      r.redirected,
    );
  }

  // redirect: 'error' rejects on a 3xx.
  {
    let name = '';
    try {
      await fetch(base + '/redirect', { redirect: 'error' });
    } catch (e) {
      name = e && e.constructor.name;
    }
    console.log('redirect error mode:', name);
  }

  // An infinite redirect loop is bounded (max 20 hops) and rejects.
  {
    let name = '';
    try {
      await fetch(base + '/redirect-loop');
    } catch (e) {
      name = e && e.constructor.name;
    }
    console.log('redirect loop bounded:', name);
  }

  // An invalid redirect mode is a TypeError at construction (not a silent 'follow').
  {
    let bad = false;
    try {
      new Request(base + '/a', { redirect: 'bogus' });
    } catch (e) {
      bad = e instanceof TypeError;
    }
    console.log('invalid redirect rejected:', bad);
  }

  // A coercible redirect value is accepted (Web IDL enum: ToString then validate),
  // e.g. a String object — Node coerces it rather than rejecting.
  {
    let mode = '';
    try {
      mode = new Request(base + '/a', { redirect: new String('manual') }).redirect;
    } catch (e) {
      mode = 'THREW:' + e.constructor.name;
    }
    console.log('coercible redirect accepted:', mode);
  }

  // A request URL carrying credentials (userinfo) is rejected: WHATWG forbids it,
  // and the visible host must not be disguisable behind a "user:pass@" prefix.
  {
    let bad = false;
    try {
      new Request('http://user:pass@127.0.0.1/');
    } catch (e) {
      bad = e instanceof TypeError;
    }
    console.log('credential URL rejected:', bad);
  }

  // Set-Cookie is not comma-joined: getSetCookie() returns each cookie intact,
  // even the one carrying a comma inside its Expires= date.
  {
    const r = await fetch(base + '/set-cookies');
    const cookies = r.headers.getSetCookie();
    console.log('set-cookie count:', cookies.length);
    console.log('set-cookie intact:', JSON.stringify(cookies));
  }

  // An invalid (non-numeric) port is rejected at Request construction — Node's URL
  // parser throws — instead of silently connecting to port 80.
  {
    let name = '';
    try {
      await fetch('http://127.0.0.1:abc/');
    } catch (e) {
      name = e && e.constructor.name;
    }
    console.log('invalid port rejected:', name);
  }

  // A port above 65535 is likewise rejected (no u16 truncation).
  {
    let name = '';
    try {
      await fetch('http://127.0.0.1:99999/');
    } catch (e) {
      name = e && e.constructor.name;
    }
    console.log('out-of-range port rejected:', name);
  }

  // IPv6 literal host: parse [::1], connect over AF_INET6, and re-bracket the
  // Host header. Only runs when the runner confirmed IPv6 loopback is up (it
  // sets FETCH_BASE6), so Node and Lava take this branch identically.
  const base6 = process.env.FETCH_BASE6;
  if (base6) {
    const r6 = await fetch(base6 + '/hello.txt');
    console.log('ipv6 hello:', r6.status, JSON.stringify(await r6.text()));
    const host6 = await fetch(base6 + '/host').then((r) => r.json());
    // Host must be the re-bracketed literal with the explicit port.
    console.log('ipv6 host header:', host6.host === base6.slice('http://'.length));
  }

  // HTTPS over TLS: same assertions as the plaintext path, against a self-signed
  // origin the runner taught both runtimes to trust (NODE_EXTRA_CA_CERTS for Node,
  // SSL_CERT_FILE for Lava). Only runs when the runner started the TLS listener, so
  // Node and Lava take this branch identically.
  const baseHttps = process.env.FETCH_BASE_HTTPS;
  if (baseHttps) {
    const s1 = await fetch(baseHttps + '/hello.txt');
    console.log('https hello:', s1.status, JSON.stringify(await s1.text()));
    const s2 = await fetch(baseHttps + '/data.json');
    console.log('https json:', JSON.stringify(await s2.json()));
    const s3 = await fetch(baseHttps + '/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tls: true, n: 7 }),
    });
    const se = await s3.json();
    console.log('https POST:', se.method, se.echo, se.len);

    // A streamed (chunked) request body over TLS exercises fetch_tls_send_chunk —
    // the buffered POST above only covers the Content-Length path. Byte-exact echo,
    // te=chunked, no cl, matching Node.
    async function* tlsGen() {
      yield new TextEncoder().encode('tls-');
      yield new TextEncoder().encode('stream');
    }
    const ss = await fetch(baseHttps + '/echo', {
      method: 'POST',
      body: tlsGen(),
      duplex: 'half',
    }).then((r) => r.json());
    console.log('https stream upload:', JSON.stringify(ss.echo), ss.te, ss.cl);

    // A large streamed body over TLS drives SSL_write backpressure (WANT_WRITE)
    // across many records. Only the reassembled length/framing is compared.
    {
      const PART = 'y'.repeat(8192);
      async function* tlsBig() {
        for (let i = 0; i < 30; i++) yield new TextEncoder().encode(PART);
      }
      const sb = await fetch(baseHttps + '/echo', {
        method: 'POST',
        body: tlsBig(),
        duplex: 'half',
      }).then((r) => r.json());
      console.log('https large stream upload:', sb.len === 30 * PART.length, sb.te);
    }

    // Concurrent HTTPS requests each get their own TLS session.
    const [sa, sb] = await Promise.all([
      fetch(baseHttps + '/a').then((r) => r.text()),
      fetch(baseHttps + '/b').then((r) => r.text()),
    ]);
    console.log('https concurrent:', sa, sb);
  }

  // Negative TLS: a server whose certificate is trusted (same CA bundle) but
  // whose SAN does not cover 127.0.0.1. The fetch must reject on the hostname
  // mismatch, proving certificate verification is actually enforced (not just
  // that trusted certs are accepted). Only runs when the runner started it.
  const baseHttpsBad = process.env.FETCH_BASE_HTTPS_BAD;
  if (baseHttpsBad) {
    let tlsRejected = false;
    try {
      await fetch(baseHttpsBad + '/hello.txt');
    } catch {
      tlsRejected = true;
    }
    console.log('https hostname-mismatch rejected:', tlsRejected);
  }

  // Connection refused rejects (port 9 is the discard port, closed here)
  let refused = false;
  try {
    await fetch('http://127.0.0.1:9/x');
  } catch {
    refused = true;
  }
  console.log('refused rejected:', refused);

  // A name that cannot resolve rejects (DNS now runs off the event loop, #30).
  // .invalid is reserved (RFC 6761) and never resolves.
  let dnsFailed = false;
  try {
    await fetch('http://does-not-exist.invalid/');
  } catch {
    dnsFailed = true;
  }
  console.log('dns failure rejected:', dnsFailed);

  // Bounded DNS pool (#77): more concurrent hostname lookups than pool workers
  // must all still resolve (queued, not dropped). localhost resolves on every host
  // and both runtimes reach the loopback server. allSettled keeps the assertion
  // robust — if a host somehow cannot resolve localhost, both runtimes report the
  // same (zero) success count, so the smoke stays in lockstep.
  {
    const port = new URL(base).port;
    const N = 12;
    const settled = await Promise.allSettled(
      Array.from({ length: N }, () =>
        fetch('http://localhost:' + port + '/a').then((r) => r.text()),
      ),
    );
    const ok = settled.filter((r) => r.status === 'fulfilled' && r.value === 'AAA').length;
    console.log('dns pool concurrency:', ok === N);
  }

  // Pre-aborted signal rejects immediately with an AbortError, never connects.
  let preAbortName = '';
  try {
    await fetch(base + '/hello.txt', { signal: AbortSignal.abort() });
  } catch (error) {
    preAbortName = error && error.name;
  }
  console.log('pre-aborted name:', preAbortName);

  // AbortController.abort() mid-flight rejects with AbortError and exits promptly.
  let midFlightName = '';
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  try {
    await fetch(base + '/never', { signal: ac.signal });
  } catch (error) {
    midFlightName = error && error.name;
  }
  console.log('mid-flight abort name:', midFlightName);

  // AbortSignal.timeout() against a never-responding server rejects and exits.
  let timeoutName = '';
  try {
    await fetch(base + '/never', { signal: AbortSignal.timeout(50) });
  } catch (error) {
    timeoutName = error && error.name;
  }
  console.log('timeout abort name:', timeoutName);

  console.log('FETCH SMOKE OK');
}

main().catch((error) => {
  console.error('FETCH SMOKE FAIL:', error && error.message ? error.message : error);
  process.exit(1);
});
