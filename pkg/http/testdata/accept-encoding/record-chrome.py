#!/usr/bin/env python3
"""Records the Accept-Encoding Chrome sends to each URL below into recorded.json, which
pkg/http/content_coding_test.odin compares accept_encoding against.

    python3 pkg/http/testdata/accept-encoding/record-chrome.py [chrome-binary]

Each URL is a top-level navigation in a fresh headless profile to a local server that
echoes the header back. Names reach the server through --host-resolver-rules; Chrome
resolves localhost and *.localhost to loopback itself. Needs openssl (a throwaway
certificate), Chrome, and 127.200.1.9 and ::1 routed to lo, as Linux does.
"""

import html
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIR = os.path.dirname(os.path.abspath(__file__))
CHROME = sys.argv[1] if len(sys.argv) > 1 else "google-chrome"
HTTP, HTTPS = 18080, 18443
NAMES = ["example.com", "plain.test", "localhost.example", "notlocalhost"]
URLS = [
    "https://example.com:%d/" % HTTPS,
    "https://127.0.0.1:%d/" % HTTPS,
    "http://127.0.0.1:%d/" % HTTP,
    "http://127.200.1.9:%d/" % HTTP,
    "http://[::1]:%d/" % HTTP,
    "http://localhost:%d/" % HTTP,
    "http://LocalHost:%d/" % HTTP,
    "http://app.localhost:%d/" % HTTP,
    "http://localhost.:%d/" % HTTP,
    "http://x.localhost.:%d/" % HTTP,
    "http://plain.test:%d/" % HTTP,
    "http://example.com:%d/" % HTTP,
    "http://localhost.example:%d/" % HTTP,
    "http://notlocalhost:%d/" % HTTP,
]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        value = self.headers.get("Accept-Encoding", "")
        body = ("<!doctype html><pre id=ae>%s</pre>" % html.escape(value)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Server(ThreadingHTTPServer):
    # Chrome opens TLS connections it never uses; their broken pipes are not news.
    def handle_error(self, request, client_address):
        pass


class Server6(Server):
    address_family = socket.AF_INET6


def serve(server_class, host, port, context=None):
    server = server_class((host, port), Handler)
    if context:
        server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def navigate(url, profile):
    rules = ", ".join("MAP %s 127.0.0.1" % name for name in NAMES)
    dom = subprocess.run(
        [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--ignore-certificate-errors",
         "--disable-features=HttpsUpgrades", "--host-resolver-rules=" + rules,
         "--user-data-dir=" + profile, "--virtual-time-budget=5000", "--dump-dom", url],
        capture_output=True, text=True, timeout=120).stdout
    start = dom.index('<pre id="ae">') + len('<pre id="ae">')
    return html.unescape(dom[start:dom.index("</pre>", start)])


def main():
    tmp = tempfile.mkdtemp()
    try:
        cert, key = os.path.join(tmp, "cert.pem"), os.path.join(tmp, "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
                        "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"], check=True, capture_output=True)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        servers = [
            serve(Server, "127.0.0.1", HTTPS, context),
            serve(Server, "127.0.0.1", HTTP),
            serve(Server, "127.200.1.9", HTTP),
            serve(Server6, "::1", HTTP),
        ]
        recorded = []
        for i, url in enumerate(URLS):
            recorded.append({"url": url, "accept_encoding": navigate(url, os.path.join(tmp, "p%d" % i))})
        for server in servers:
            server.shutdown()
    finally:
        shutil.rmtree(tmp)

    version = subprocess.run([CHROME, "--version"], capture_output=True, text=True).stdout.strip()
    with open(os.path.join(DIR, "recorded.json"), "w") as f:
        json.dump({"chrome": version, "cases": recorded}, f, indent="\t")
        f.write("\n")
    print(version, "-", len(recorded), "URLs recorded")


main()
