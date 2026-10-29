"""Small HTTP service that reports which pod, node and AZ answered and drains on SIGTERM.

Passed to `python -c` by the Deployment manifest, so it uses the standard library only.
The pod and node identity come from the Downward API (see lib/constructs/web-app.ts).
"""
import json
import os
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
DRAIN_SECONDS = int(os.environ.get("DRAIN_SECONDS", "10"))
STARTED_AT = time.time()
draining = threading.Event()

META = {
    "cluster": os.environ.get("CLUSTER_MODE", "unknown"),
    "pod": os.environ.get("POD_NAME", "local"),
    "node": os.environ.get("NODE_NAME", "local"),
    # Empty when the API server does not copy the node topology labels onto the pod.
    "az": os.environ.get("ZONE") or "unknown",
}


def log(event, **fields):
    print(json.dumps({"event": event, "ts": round(time.time(), 3), **fields}), flush=True)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            # 503 while draining so the ALB stops sending new requests to this pod.
            self._send(503 if draining.is_set() else 200, {"draining": draining.is_set()})
            return
        self._send(200, {**META, "draining": draining.is_set(), "uptime": round(time.time() - STARTED_AT)})

    def log_message(self, *args):
        pass


def on_sigterm(signum, frame):
    # Sent by a rollout, scale-in, node drain or node replacement.
    log("SIGTERM", drainSeconds=DRAIN_SECONDS, **META)
    draining.set()

    def stop():
        time.sleep(DRAIN_SECONDS)
        log("EXIT", **META)
        os._exit(0)

    threading.Thread(target=stop, daemon=True).start()


signal.signal(signal.SIGTERM, on_sigterm)
server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
log("START", port=PORT, **META)
threading.Thread(target=server.serve_forever, daemon=True).start()
while True:
    time.sleep(3600)
