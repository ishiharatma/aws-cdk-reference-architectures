"""Small HTTP service that reports which task and AZ answered and drains on SIGTERM.

Passed to `python -c` by the CDK stack, so it uses the standard library only.
"""
import json
import os
import signal
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
DRAIN_SECONDS = int(os.environ.get("DRAIN_SECONDS", "15"))
STARTED_AT = time.time()
draining = threading.Event()


def log(event, **fields):
    print(json.dumps({"event": event, "ts": round(time.time(), 3), **fields}), flush=True)


def task_metadata():
    """Read the task ARN and AZ from the ECS task metadata endpoint v4."""
    uri = os.environ.get("ECS_CONTAINER_METADATA_URI_V4")
    if not uri:
        return {"taskId": "local", "az": "local"}
    with urllib.request.urlopen(f"{uri}/task", timeout=2) as res:
        meta = json.load(res)
    return {"taskId": meta["TaskARN"].rsplit("/", 1)[-1], "az": meta.get("AvailabilityZone", "unknown")}


META = task_metadata()


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
            # 503 while draining so the ALB stops sending new requests to this task.
            self._send(503 if draining.is_set() else 200, {"draining": draining.is_set()})
            return
        self._send(200, {**META, "draining": draining.is_set(), "uptime": round(time.time() - STARTED_AT)})

    def log_message(self, *args):
        pass


def on_sigterm(signum, frame):
    # Sent by StopTask, a deployment, scale-in, AZ rebalancing, or a Spot interruption notice.
    log("SIGTERM", drainSeconds=DRAIN_SECONDS, **META)
    draining.set()

    def shutdown():
        time.sleep(DRAIN_SECONDS)
        log("EXIT", **META)
        server.shutdown()

    threading.Thread(target=shutdown, daemon=True).start()


server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
signal.signal(signal.SIGTERM, on_sigterm)
log("START", port=PORT, **META)
server.serve_forever()
sys.exit(0)
