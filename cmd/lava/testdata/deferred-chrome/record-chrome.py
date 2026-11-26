#!/usr/bin/env python3
"""Records Chrome's answer to case.js into expected.txt (the Window profile's oracle for
cmd/lava/runloop_drive_test.odin, web_page_sees_finalization_and_wasm_as_chrome_does).

A local page loads case.js after defining `collect()` as V8's own full GC (`gc()`, which
--js-flags=--expose-gc exposes) followed by a 50 ms turn, and prints `report` into the
DOM once the case sets it; headless Chrome dumps the DOM.

    python3 cmd/lava/testdata/deferred-chrome/record-chrome.py [chrome-binary]

Writes the Chrome version to chrome-version.txt beside the recording. 127.0.0.1 is a
secure context, which nothing here needs; the page is served rather than opened from
file:// only so the case script loads the same way on every run.
"""

import html
import os
import re
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIR = os.path.dirname(os.path.abspath(__file__))
CHROME = sys.argv[1] if len(sys.argv) > 1 else "google-chrome"
CASE = open(os.path.join(DIR, "case.js"), "rb").read()

PAGE = b"""<!doctype html><pre id=out></pre><script>
globalThis.collect = async () => {
  gc();
  await new Promise((resolve) => setTimeout(resolve, 50));
};
</script><script src="/case.js"></script><script>
(function wait() {
  if (globalThis.report == null) return setTimeout(wait, 10);
  document.getElementById('out').textContent = globalThis.report;
})();
</script>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/":
            self.reply(200, "text/html", PAGE)
        elif self.path == "/case.js":
            self.reply(200, "text/javascript", CASE)
        else:
            self.reply(404, "text/plain", b"")

    def reply(self, status, ctype, body):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/" % server.server_address[1]
    with tempfile.TemporaryDirectory() as profile:
        dom = subprocess.run(
            [
                CHROME,
                "--headless=new",
                "--no-sandbox",
                "--user-data-dir=" + profile,
                "--js-flags=--expose-gc",
                "--virtual-time-budget=5000",
                "--dump-dom",
                url,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout
    server.shutdown()
    match = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not match or not match.group(1):
        sys.exit("no report in Chrome's DOM:\n" + dom)
    with open(os.path.join(DIR, "expected.txt"), "w") as f:
        f.write(html.unescape(match.group(1)) + "\n")
    version = subprocess.run([CHROME, "--version"], capture_output=True, text=True).stdout.strip()
    with open(os.path.join(DIR, "chrome-version.txt"), "w") as f:
        f.write(version + "\n")


if __name__ == "__main__":
    main()
