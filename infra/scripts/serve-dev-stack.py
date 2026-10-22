#!/usr/bin/env python3
"""YET Phase 0 dev/staging static stack (substitute for nginx+tileserver-gl when Docker is unavailable).

Serves:
  * /tiles/{z}/{x}/{y}.png  -> placeholder tiles from infra/tiles/rendered/
    with Cache-Control: public, max-age=86400 (§1.9.3 edge-cache parity with infra/nginx.conf)
  * everything else         -> built dashboard SPA from web-dashboard/dist/

Usage:  python3 infra/scripts/serve-dev-stack.py [port]   (default 8099)
Stop:   Ctrl-C
"""
import http.server
import socketserver
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # /workspace-ish: infra/
WS = os.path.dirname(ROOT)                                          # repo root
TILES = os.path.join(ROOT, "tiles", "rendered")
DIST = os.path.join(WS, "web-dashboard", "dist")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8099


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.split("?")[0]

        m = re.match(r"^/tiles/(\d+)/(\d+)/(\d+)\.png$", p)
        if m:
            f = os.path.join(TILES, m.group(1), m.group(2), m.group(3) + ".png")
            if os.path.isfile(f):
                with open(f, "rb") as fh:
                    data = fh.read()
                self._send(200, data, "image/png", {
                    # §1.9.3: tiles cached at edge for 24 hours; parity with nginx.conf
                    "Cache-Control": "public, max-age=86400",
                    "Access-Control-Allow-Origin": "*",
                })
            else:
                self.send_error(404)
            return

        # Static SPA from dist/
        rel = p[1:] or "index.html"
        f = os.path.normpath(os.path.join(DIST, rel))
        if not f.startswith(DIST):
            self.send_error(403)
            return
        if os.path.isdir(f):
            f = os.path.join(f, "index.html")
        if os.path.isfile(f):
            ext = os.path.splitext(f)[1]
            ctype = {
                ".html": "text/html",
                ".js": "application/javascript",
                ".css": "text/css",
                ".png": "image/png",
                ".svg": "image/svg+xml",
                ".json": "application/json",
            }.get(ext, "application/octet-stream")
            with open(f, "rb") as fh:
                data = fh.read()
            cache = "no-cache" if ext == ".html" else "public, max-age=31536000, immutable"
            self._send(200, data, ctype, {"Cache-Control": cache})
            return

        # SPA fallback
        idx = os.path.join(DIST, "index.html")
        if os.path.isfile(idx):
            self._send(200, open(idx, "rb").read(), "text/html", {"Cache-Control": "no-cache"})
        else:
            self.send_error(404, "dashboard not built - run `npm run build` in web-dashboard/")


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as srv:
        print(f"YET dev stack: http://127.0.0.1:{PORT}/  (tiles: /tiles/z/x/y.png from {TILES})", flush=True)
        srv.serve_forever()
