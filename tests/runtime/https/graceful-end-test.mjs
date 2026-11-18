// T2: a graceful TLS close (the client's close_notify, then FIN) must fire the server's net.Socket
// 'end' EXACTLY once — the readiness-backend double-'end' regression. Self-contained: it spawns the
// Lava HTTPS server (server.js logs a SOCKETEND line per net.Socket 'end' via req.socket), drives ONE
// request with a raw tls.connect, then socket.end() for a clean close_notify (the keep-alive http
// agent's close is not a clean shutdown, hence a raw socket here). It reads the server's stdout AFTER
// the server exits (Lava flushes on exit) and asserts exactly one 'end'. Run once per backend by the
// smoke (LAVA_NET_FORCE_READINESS passed through). Skipped by the runner if node is unavailable.
import { spawn } from 'node:child_process';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';

const LAVA = process.env.LAVA_BIN;
const TLS_DIR = process.env.TLS_DIR;
const SERVER = path.join(path.dirname(new URL(import.meta.url).pathname), 'server.js');
const ca = fs.readFileSync(path.join(TLS_DIR, 'cert.pem'));
const label = process.env.LAVA_NET_FORCE_READINESS ? 'readiness' : 'proactor';

const srv = spawn(LAVA, ['run', SERVER], {
  env: {
    ...process.env,
    TLS_KEY: path.join(TLS_DIR, 'key.pem'),
    TLS_CERT: path.join(TLS_DIR, 'cert.pem'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
srv.stdout.on('data', (d) => (out += d));
srv.stderr.on('data', (d) => (out += d));

function fail(msg) {
  console.error('GRACEFUL-END FAIL (' + label + '): ' + msg + '\n--- server output ---\n' + out);
  try {
    srv.kill('SIGKILL');
  } catch {}
  process.exit(1);
}

function waitPort() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = out.match(/READYPORT=(\d+)/);
      if (m) {
        clearInterval(iv);
        resolve(+m[1]);
      } else if (Date.now() - t0 > 5000 || srv.exitCode !== null) {
        clearInterval(iv);
        reject(new Error('server never became ready'));
      }
    }, 50);
  });
}

let port;
try {
  port = await waitPort();
} catch (e) {
  fail(e.message);
}

// No `servername`: node 26 rejects an IP address there (ERR_INVALID_ARG_VALUE, RFC 6066
// forbids IP SNI). Without it the identity is checked against `host`, which the smoke
// cert carries as IP:127.0.0.1.
const sock = tls.connect({ host: '127.0.0.1', port, ca }, () => {
  sock.write(
    'POST /g HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nhi',
  );
});
let resp = '';
await new Promise((resolve) => {
  sock.on('data', (d) => {
    resp += d;
    if (resp.includes('echo:POST:/g:hi')) sock.end(); // graceful close_notify
  });
  sock.on('close', resolve);
  sock.on('error', resolve);
  setTimeout(resolve, 5000);
});

if (!resp.includes('echo:POST:/g:hi'))
  fail('no/!bad response over TLS: ' + JSON.stringify(resp.slice(0, 80)));

// Let the server process the close, then stop it and wait for exit so its stdout flushes.
await new Promise((r) => setTimeout(r, 300));
await new Promise((resolve) => {
  srv.on('close', resolve);
  srv.kill('SIGTERM');
  setTimeout(resolve, 3000);
});

const ends = (out.match(/^SOCKETEND$/gm) || []).length;
if (ends !== 1)
  fail("net.Socket 'end' fired " + ends + ' times on a graceful close (expected exactly 1)');
console.log('GRACEFUL-END OK (' + label + "): single 'end' on graceful TLS close");
