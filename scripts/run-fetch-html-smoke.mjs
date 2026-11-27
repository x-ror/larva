#!/usr/bin/env node
// `make test-fetch-html-smoke`: `lava fetch` end to end (DOM stage 3c) — a redirect,
// a content coding and the charset of the page it lands on — against a local origin,
// with Chrome's recording as the expectation.
//
// Each check serves the bytes of a tests/dom navigation case (navCharset) behind a
// 302, compressed, with the case's own Content-Type, and requires `lava fetch`'s stdout
// to equal the case's recorded `#serialize` view byte for byte: the same page Chrome
// decoded and serialized when the case was recorded, reached over HTTP instead of from
// a file. The redirect and the coding are pkg/http's; the charset is pkg/html's
// decode_document with Content-Type's label (cmd/lava/main.odin fetch_command).
//
// Not in `make test`: it binds a 127.0.0.1 port, as test-fetch-smoke does. Needs
// bin/lava and node (zlib for gzip, brotli and zstd), not Chrome.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { CASES_DIR, navCharset, navContentType, splitViews } from './lib/dom-oracle.mjs';
import { ROOT, parseExpected } from './lib/web-oracle.mjs';

const LAVA = process.env.LAVA_BIN || join(ROOT, 'bin/lava');

// Each case is one of the encodings' paths through decode_document: a <meta> prescan
// (http-equiv), Content-Type's label over a contrary <meta>, a BOM, Shift_JIS, and the
// windows-1252 default. Codings rotate over them; to 127.0.0.1 Lava offers all four
// (pkg/http accept_encoding).
const CHECKS = [
  ['site-legacy-latin1.nav', 'gzip'],
  ['charset-transport.nav-windows-1252', 'br'],
  ['site-forum-thread.nav', 'zstd'],
  ['site-jp-portal.nav', 'gzip'],
  ['charset-default.nav', 'identity'],
];

const ENCODERS = {
  gzip: gzipSync,
  br: brotliCompressSync,
  zstd: zstdCompressSync,
  identity: (b) => b,
};

const server = createServer((req, res) => {
  const m = /^\/(go|page)\/([\w.-]+)\/(\w+)$/.exec(req.url);
  if (!m) {
    res.writeHead(404, { 'Content-Length': '0' });
    return res.end();
  }
  const [, kind, name, coding] = m;
  if (kind === 'go') {
    res.writeHead(302, { Location: `/page/${name}/${coding}`, 'Content-Length': '0' });
    return res.end();
  }
  const body = ENCODERS[coding](readFileSync(join(CASES_DIR, `${name}.html`)));
  const headers = {
    'Content-Type': navContentType(navCharset(name)),
    'Content-Length': String(body.length),
  };
  if (coding !== 'identity') headers['Content-Encoding'] = coding;
  res.writeHead(200, headers);
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
for (const [name, coding] of CHECKS) {
  const want = splitViews(
    parseExpected(readFileSync(join(CASES_DIR, `${name}.expected`), 'utf8')).output,
  ).serialize;
  // Asynchronous: a synchronous spawn would block the server this process runs.
  const run = await runLava(['fetch', `${origin}/go/${name}/${coding}`]);
  const got = run.stdout.toString('utf8');
  const stderr = run.stderr.toString('utf8');
  if (run.status === 0 && got === want && /\(1 redirects\)/.test(stderr)) {
    console.log(
      `PASS ${name} (${coding}; ${/^charset: .*$/m.exec(stderr)?.[0] ?? 'no charset line'})`,
    );
  } else {
    failed++;
    console.log(`FAIL ${name} (${coding}): exit ${run.status}\n${stderr}`);
    const at = [...want].findIndex((ch, i) => ch !== got[i]);
    console.log(`  first difference at ${at}: want ${JSON.stringify(want.slice(at, at + 40))}`);
    console.log(`                         got  ${JSON.stringify(got.slice(at, at + 40))}`);
  }
}
server.close();
console.log(`fetch html smoke: ${CHECKS.length - failed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);

function runLava(args) {
  return new Promise((resolve) => {
    const child = spawn(LAVA, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (status) =>
      resolve({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }),
    );
  });
}
