"""Isolated HTTP/SSE fixture for the real Windows/WSL acceptance test."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys

# The supervisor must kill this descendant as well as the HTTP server.
worker = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
Path("worker.pid").write_text(str(worker.pid))
expected = "Basic " + base64.b64encode(("opencode:" + os.environ["OPENCODE_SERVER_PASSWORD"]).encode()).decode()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("Authorization") != expected:
            self.send_error(401)
            return
        if self.path.startswith("/event"):
            body = b'data: {"type":"fixture.ready"}\n\n'
            content_type = "text/event-stream"
        else:
            body = json.dumps({"healthy": True, "cwd": os.getcwd(), "worker": worker.pid}).encode()
            content_type = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print("http://127.0.0.1:%d" % server.server_port, flush=True)
server.serve_forever()
