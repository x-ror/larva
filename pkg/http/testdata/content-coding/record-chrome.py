#!/usr/bin/env python3
"""Records what Chrome decodes from each fixture gen.mjs wrote: <name>.out holds the
bytes fetch() returned, <name>.err marks a network error. Secure cases are fetched by a
page on https://127.0.0.1 (a secure context, so Chrome offers br and zstd); the others
by a page on http://plain.test, mapped to 127.0.0.1 so it is not one.

Each case gets its own page and profile. With every case fetched in turn from one page,
a fetch after a failed one could fail too: after stack-11 failed, every raw-* case and
empty-body recorded a network error, where each decodes when fetched alone.

    python3 pkg/http/testdata/content-coding/record-chrome.py [chrome-binary]

Needs openssl (a throwaway certificate) and Chrome; writes the Chrome version to
chrome-version.txt beside the recordings.
"""

import base64
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIR = os.path.dirname(os.path.abspath(__file__))
CHROME = sys.argv[1] if len(sys.argv) > 1 else "google-chrome"
CASES = json.load(open(os.path.join(DIR, "cases.json")))
BY_NAME = {c["name"]: c for c in CASES}

PAGE = """<!doctype html><pre id=out></pre><script>
(async () => {
  const names = [%s], result = {};
  for (const name of names) {
    try {
      const bytes = new Uint8Array(await (await fetch('/f/' + name)).arrayBuffer());
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      result[name] = btoa(s);
    } catch (e) {
      result[name] = null;
    }
  }
  document.getElementById('out').textContent = JSON.stringify(result);
})();
</script>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/run?case=") and self.path[10:] in BY_NAME:
            page = PAGE % json.dumps(self.path[10:])
            self.reply(200, [("Content-Type", "text/html")], page.encode())
        elif self.path.startswith("/f/") and self.path[3:] in BY_NAME:
            case = BY_NAME[self.path[3:]]
            body = open(os.path.join(DIR, case["name"] + ".in"), "rb").read()
            headers = [("Content-Type", "application/octet-stream")]
            headers += [("Content-Encoding", e) for e in case["encoding"]]
            self.reply(200, headers, body)
        else:
            self.reply(404, [], b"")

    def reply(self, status, headers, body):
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(port, context=None):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    if context:
        server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run_page(url, profile):
    dom = subprocess.run(
        [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--ignore-certificate-errors",
         "--host-resolver-rules=MAP plain.test 127.0.0.1", "--user-data-dir=" + profile,
         "--virtual-time-budget=20000", "--dump-dom", url],
        capture_output=True, text=True, timeout=120).stdout
    start = dom.index('<pre id="out">') + len('<pre id="out">')
    return json.loads(dom[start:dom.index("</pre>", start)])


def main():
    tmp = tempfile.mkdtemp()
    try:
        cert, key = os.path.join(tmp, "cert.pem"), os.path.join(tmp, "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
                        "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], check=True, capture_output=True)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        servers = [serve(18443, context), serve(18080)]
        result = {}
        for i, case in enumerate(CASES):
            origin = "https://127.0.0.1:18443" if case["secure"] else "http://plain.test:18080"
            url = origin + "/run?case=" + case["name"]
            result.update(run_page(url, os.path.join(tmp, "p%d" % i)))
        for server in servers:
            server.shutdown()
    finally:
        shutil.rmtree(tmp)

    for case in CASES:
        name = case["name"]
        for ext in (".out", ".err"):
            if os.path.exists(os.path.join(DIR, name + ext)):
                os.remove(os.path.join(DIR, name + ext))
        value = result[name]
        if value is None:
            open(os.path.join(DIR, name + ".err"), "wb").close()
        else:
            open(os.path.join(DIR, name + ".out"), "wb").write(base64.b64decode(value))
    version = subprocess.run([CHROME, "--version"], capture_output=True, text=True).stdout.strip()
    open(os.path.join(DIR, "chrome-version.txt"), "w").write(version + "\n")
    print(version, "-", len(CASES), "cases recorded")


main()
