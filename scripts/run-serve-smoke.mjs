#!/usr/bin/env node
// `make test-serve`'s process half: `lava serve` as an operator runs it, stopped by a
// signal. The Odin tests (cmd/lava/serve_test.odin) drive the server in-process and stop
// it through server_stop; what they cannot reach is the CLI around it — the flags, the
// SIGTERM handler's self-pipe (pkg/adapters serve_stop_on_signals) and the exit code.
//
// Checks, against a node fixture origin on 127.0.0.1:
//   1. a request renders (the inline script's DOM write is in the body), and a
//      `wait=networkidle` request has what an SPA fetched after load;
//   2. SIGTERM while a request is in flight: that request is still answered 200, and the
//      process exits 0 once it has been;
//   3. SIGINT on an idle server exits 0 as well.
//
// Binds 127.0.0.1 ports, so it is not in `make test`. Needs bin/lava and node, not Chrome.

import { spawn } from 'node:child_process';
import { createServer, get } from 'node:http';
import { join } from 'node:path';
import { ROOT } from './lib/web-oracle.mjs';

const LAVA = process.env.LAVA_BIN || join(ROOT, 'bin/lava');

const PAGES = {
  '/a': '<!doctype html><p id="x">static</p><script>document.getElementById("x").textContent = "js ran";</script>',
  // `load` waits 400 ms for its timer: long enough to be in flight when the signal lands.
  '/slow':
    '<!doctype html><body><script>setTimeout(() => { document.body.id = "slow-done"; }, 400)</script></body>',
  // An SPA under a perpetual timer: only a network-idle wait captures what its fetch got.
  '/spa':
    '<!doctype html><body><p id="out">empty</p><script>setInterval(() => {}, 20);' +
    'addEventListener("load", () => fetch("/data").then((r) => r.text()).then((t) => {' +
    'document.getElementById("out").textContent = t; }));</script></body>',
  '/data': 'fetched',
};

let served = 0;
const origin = createServer((req, res) => {
  const body = PAGES[req.url];
  served++;
  res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  // /data answers late, so the SPA's request is in flight across several of its ticks.
  setTimeout(() => res.end(body ?? ''), req.url === '/data' ? 100 : 0);
});
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const originUrl = `http://127.0.0.1:${origin.address().port}`;

let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${ok || !detail ? '' : `\n  ${detail}`}`);
  if (!ok) failed++;
};

for (const signal of ['SIGTERM', 'SIGINT']) {
  const lava = await startLava();

  if (!lava) {
    check(false, `${signal}: lava serve started`, 'no "listening on port" line');
    continue;
  }

  if (signal === 'SIGTERM') {
    const page = await render(lava.port, '/a');
    check(
      page.status === 200 && page.body.includes('<p id="x">js ran</p>'),
      'a request renders the page after its script',
      `${page.status} ${page.headers['x-larva-error'] ?? ''} ${page.body}`,
    );
    const spa = await render(lava.port, '/spa', '&wait=networkidle&idle_ms=200');
    check(
      spa.status === 200 && spa.body.includes('<p id="out">fetched</p>'),
      'wait=networkidle captures what the page fetched after load, timers running',
      `${spa.status} ${spa.headers['x-larva-error'] ?? ''} ${spa.body}`,
    );
    const before = served;
    const inflight = render(lava.port, '/slow');
    // Past navigation before the signal, so the request has been admitted.
    while (served === before) await new Promise((r) => setTimeout(r, 5));
    lava.child.kill(signal);
    const slow = await inflight;
    check(
      slow.status === 200 && slow.body.includes('id="slow-done"'),
      'SIGTERM: the request in flight is still answered',
      `${slow.status} ${slow.headers['x-larva-error'] ?? ''} ${slow.body}`,
    );
  } else {
    lava.child.kill(signal);
  }

  const status = await lava.exited;
  check(status === 0, `${signal}: lava serve exits 0`, `exit ${status}\n${lava.stderr()}`);
}

origin.close();
console.log(`serve smoke: ${failed ? `${failed} failed` : 'all passed'}`);
process.exit(failed ? 1 : 0);

// startLava runs `lava serve` on a free port and resolves once it says which.
function startLava() {
  return new Promise((resolve) => {
    const child = spawn(LAVA, ['serve', '--listen', '127.0.0.1:0', '--threads', '2'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const err = [];
    const exited = new Promise((r) => child.on('close', (status) => r(status)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, 10_000);
    child.stderr.on('data', (d) => {
      err.push(d);
      const m = /listening on port (\d+)/.exec(Buffer.concat(err).toString());
      if (m) {
        clearTimeout(timer);
        resolve({ child, exited, port: Number(m[1]), stderr: () => Buffer.concat(err).toString() });
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function render(port, path, extra = '') {
  const url = encodeURIComponent(originUrl + path);
  return new Promise((resolve) => {
    get(`http://127.0.0.1:${port}/render?url=${url}${extra}`, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    }).on('error', (e) => resolve({ status: 0, headers: {}, body: String(e) }));
  });
}
