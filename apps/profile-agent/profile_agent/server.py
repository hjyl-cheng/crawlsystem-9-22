"""Profile Agent: a resident local-model inference service for Workers.

POST /v1/profile   body: AgentInput JSON  ->  200 {model_version, taxonomy_version, observed_at, facts, diagnostics}
                                             422 input cannot be profiled (do not retry the same input)
GET  /healthz      200 once every active model artifact is loaded and verified

Stateless and read-only: no database, no credentials. Requests are served one at a
time (inference is CPU-bound and takes well under a second).
"""
from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from qy_channel_profile.model_bundle import ModelBundle
from qy_channel_profile.processor import ChannelProfileProcessor

from .adapter import InputError, Profiler

MAX_BODY = 16 * 1024 * 1024


def _log(event: str, **fields: object) -> None:
    sys.stdout.write(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "service": "profile-agent", "event": event, **fields}) + "\n")
    sys.stdout.flush()


def make_handler(profiler: Profiler) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "profile-agent"
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - access log is replaced by structured events
            pass

        def _send(self, status: int, body: dict[str, object]) -> None:
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/healthz":
                self._send(200, {"ok": True, "model_version": profiler.model_version})
            else:
                self._send(404, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/v1/profile":
                self._send(404, {"error": "not_found"})
                return
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > MAX_BODY:
                self._send(413 if length > MAX_BODY else 400, {"error": "invalid_body"})
                return
            started = time.monotonic()
            traceparent = self.headers.get("traceparent")
            try:
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise InputError("body must be an object")
                result = profiler.profile(body)
            except (InputError, json.JSONDecodeError) as error:
                _log("profile_rejected", error=str(error)[:500], traceparent=traceparent)
                self._send(422, {"error": "invalid_input", "message": str(error)[:500]})
                return
            except Exception as error:  # noqa: BLE001 - reported to the caller as a retryable failure
                _log("profile_failed", error=f"{type(error).__name__}: {error}"[:500], traceparent=traceparent)
                self._send(500, {"error": "profile_failed", "message": f"{type(error).__name__}: {error}"[:500]})
                return
            _log("profiled", channel_id=body.get("channel_id"), videos=len(body.get("videos") or []),
                 duration_ms=int((time.monotonic() - started) * 1000), traceparent=traceparent)
            self._send(200, result)

    return Handler


def main() -> None:
    bundle_path = os.environ.get("PROFILE_MODEL_MANIFEST", "/app/models/manifest.json")
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "18120"))
    started = time.monotonic()
    profiler = Profiler(ChannelProfileProcessor(model_bundle=ModelBundle.load(bundle_path)))
    profiler.warm_up()
    _log("ready", model_version=profiler.model_version, load_ms=int((time.monotonic() - started) * 1000), port=port)
    server = HTTPServer((host, port), make_handler(profiler))
    # shutdown() blocks until serve_forever returns, so it cannot run on the serving thread.
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
