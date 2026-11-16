// node:http is assembled from internal modules laid out like node's own http files:
// js/internal/http/{common,incoming,outgoing,server}.js stand where node keeps
// _http_common, _http_incoming, _http_outgoing and _http_server. An error thrown from
// inside the moved code used to carry a `node:http:<line>` frame, because everything was
// defined in node/http.js; now it carries the internal file's name, as node's does.
//
// The NAME differs from node's, deliberately, so this case prints it runtime-neutrally.
// Node exposes `require('_http_server')` and friends publicly (probed on 26.13.0: no
// deprecation warning), with export shapes Lava does not implement (parsers, HTTPParser,
// OutgoingMessage, setupConnectionsTracking, ...). Publishing a js/node/_http_server.js
// would make a requireable module whose keys disagree with node's, so the files live under
// internal/ and the frames read `node:internal/http/<file>` where node's read
// `node:_http_<file>`. Each frame line therefore asks "is the frame from a moved http
// file" (either spelling) and "is the old `node:http:` frame gone" — both false before
// the split on Lava, both true/false-as-node after it. Only the source name is compared,
// never the message's line or column.
//
// The behavior lines after that are there so a move that loses a helper, breaks a
// prototype chain or re-wires an identity fails here and not only in a stack. A raw
// net client drives the server (Lava has no http.request); responses are framed by the
// parser below, never by waiting for 'end', so a framing regression fails as a diff
// rather than a CI timeout (see exchange's guard).
'use strict';

const http = require('node:http');
const net = require('node:net');
const EventEmitter = require('node:events');

function frame(label, f) {
  let stack = null;
  let code = null;
  try {
    f();
  } catch (e) {
    stack = String(e && e.stack);
    code = e && e.code;
  }
  if (stack === null) return console.log(label + ': NO THROW');
  const moved = stack.includes('node:internal/http/') || stack.includes('node:_http_');
  console.log(label + ': ' + code + ' moved=' + moved + ' old=' + stack.includes('node:http:'));
}

// --- the public entry: same five members Lava implements, same identities ------------
console.log(
  'members',
  ['createServer', 'Server', 'IncomingMessage', 'ServerResponse', 'STATUS_CODES']
    .map((k) => k + ':' + typeof http[k])
    .join(' '),
);
console.log('node: prefix identity', require('http') === http);
console.log('STATUS_CODES', http.STATUS_CODES[200], http.STATUS_CODES[404], http.STATUS_CODES[500]);
for (const C of [http.Server, http.IncomingMessage, http.ServerResponse]) {
  console.log(C.name, 'is an EventEmitter', C.prototype instanceof EventEmitter);
}

// Splits a raw byte stream into complete responses (Content-Length or chunked), so the
// client can stop as soon as the expected count has arrived.
function parseResponses(raw) {
  const out = [];
  let at = 0;
  for (;;) {
    const headEnd = raw.indexOf('\r\n\r\n', at);
    if (headEnd < 0) return out;
    const lines = raw.slice(at, headEnd).split('\r\n');
    const headers = {};
    for (const l of lines.slice(1)) {
      const c = l.indexOf(':');
      headers[l.slice(0, c).toLowerCase()] = l.slice(c + 1).trim();
    }
    let p = headEnd + 4;
    let body = '';
    if (headers['transfer-encoding'] === 'chunked') {
      for (;;) {
        const e = raw.indexOf('\r\n', p);
        if (e < 0) return out;
        const n = parseInt(raw.slice(p, e), 16);
        if (raw.length < e + 2 + n + 2) return out;
        body += raw.slice(e + 2, e + 2 + n);
        p = e + 2 + n + 2;
        if (n === 0) break;
      }
    } else {
      const n = Number(headers['content-length'] || 0);
      if (raw.length < p + n) return out;
      body = raw.slice(p, p + n);
      p += n;
    }
    out.push({ status: lines[0], headers, body });
    at = p;
  }
}

// The guard turns a server that never answers into a diff naming the request, not a hang
// the runner can only report as a timeout: Lava keeps running after an uncaught throw in a
// socket listener, where node exits, so a broken server half would otherwise just stall.
function exchange(server, payload, count) {
  return new Promise((resolve, reject) => {
    const c = net.connect(server.address().port, () => c.write(payload));
    let raw = '';
    const guard = setTimeout(() => {
      c.destroy();
      reject(new Error('no complete response to ' + JSON.stringify(payload.slice(0, 16))));
    }, 10000);
    c.on('data', (d) => {
      raw += d.toString('latin1');
      const got = parseResponses(raw);
      if (got.length < count) return;
      clearTimeout(guard);
      c.destroy();
      resolve(got);
    });
    c.on('error', reject);
  });
}

function show(label, r) {
  console.log(
    label,
    JSON.stringify(r.status),
    'connection=' + r.headers['connection'],
    'te=' + r.headers['transfer-encoding'],
    'cl=' + r.headers['content-length'],
    'body=' + JSON.stringify(r.body),
  );
}

async function main() {
  let firstSocket = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/a') {
      firstSocket = req.socket;
      // Errors thrown by the moved validators, from a ServerResponse a real server made.
      frame('setHeader(bad name)', () => res.setHeader('a b', 1));
      frame('setHeader(bad value)', () => res.setHeader('X', 'a\nb'));
      frame('writeHead(5)', () => res.writeHead(5));
      console.log('request', req.method, req.url, req.httpVersion, req.headers.host);
      console.log('IncomingMessage', req instanceof http.IncomingMessage);
      console.log('ServerResponse', res instanceof http.ServerResponse);
      res.setHeader('X-Case', 'a');
      res.end('A');
      return;
    }
    if (req.url === '/b') {
      console.log('keep-alive reused socket', req.socket === firstSocket);
      res.write('b1');
      res.end('b2');
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => res.end('echo:' + body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // Two pipelined requests on one connection: keep-alive, then a chunked response.
  const pipelined = await exchange(
    server,
    'GET /a HTTP/1.1\r\nHost: x\r\n\r\nGET /b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
    2,
  );
  show('/a', pipelined[0]);
  console.log('/a x-case', pipelined[0].headers['x-case']);
  show('/b', pipelined[1]);

  // A chunked request body, reassembled by the moved decoder.
  const echoed = await exchange(
    server,
    'POST /echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n' +
      '4\r\nAAAA\r\n3;ext=1\r\nBBB\r\n0\r\nTrailer: t\r\n\r\n',
    1,
  );
  show('/echo', echoed[0]);

  // A malformed chunk size is still a 400 from the moved framing path.
  const bad = await exchange(
    server,
    'POST /echo HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n',
    1,
  );
  console.log('bad chunk', JSON.stringify(bad[0].status));
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
