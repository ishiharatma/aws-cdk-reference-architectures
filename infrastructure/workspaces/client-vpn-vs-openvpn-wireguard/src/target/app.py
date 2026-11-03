"""Private web server used as the connection target of the three VPN methods.

GET /whoami      -> JSON with the source address the server saw (shows each VPN's SNAT)
GET /blob?mb=N   -> N MiB of zeros, used to measure throughput through the tunnel
"""

import json
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

CHUNK = b"\0" * (1024 * 1024)
MAX_MB = 1024


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (http.server naming)
        url = urlparse(self.path)
        if url.path == "/blob":
            mb = min(int(parse_qs(url.query).get("mb", ["10"])[0]), MAX_MB)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(mb * len(CHUNK)))
            self.end_headers()
            for _ in range(mb):
                self.wfile.write(CHUNK)
            return
        body = json.dumps(
            {
                "hostname": socket.gethostname(),
                "remote_addr": self.client_address[0],
                "path": url.path,
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 80), Handler).serve_forever()
