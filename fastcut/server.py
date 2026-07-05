"""
Optional persistent sidecar — stdlib http.server (no FastAPI/uvicorn/Starlette).

The Node side uses the one-shot CLI (fastcut.cli) by default — simplest, and the
heuristic core starts in ~0.3 s. But when the model tiers (semantic / audio) are
on, loading them costs seconds, so you don't want to pay it on every Fast Cut. Run
this once and the models stay warm for the life of the process (the SemanticModel
singleton + AudioEmbedder._model_cache persist across requests):

    python -m fastcut.server            # 127.0.0.1:8799

Endpoints:
    GET  /health   -> {"ok": true, "semantic": bool}
    POST /detect   {"words":[...], "audio_path?":..., "config?":{...}, "verbose?":bool}
                   -> {"cuts":[{cut_start,cut_end,confidence}], "meta":{...}}

Stdlib on purpose: FastAPI/Starlette/pydantic version drift broke the old app
(422 on /detect, 500 on /openapi.json); http.server has no such dependency risk.
The EaseCutPro Node adapter auto-detects a running sidecar (GET /health) and uses
it; otherwise it falls back to spawning the CLI.
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .engine import run_json


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, obj) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] == "/health":
            try:
                from . import semantic

                sem = semantic.available()
            except Exception:
                sem = False
            self._send(200, {"ok": True, "semantic": sem})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/detect":
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            payload = json.loads(self.rfile.read(n) or b"{}")
            self._send(200, run_json(payload))
        except Exception as e:  # never crash the sidecar on a bad request
            self._send(400, {"error": str(e)})

    def log_message(self, *_a) -> None:  # keep the console quiet
        pass


def build_app():
    """Back-compat shim (the stdlib server needs no app object)."""
    return _Handler


def main() -> None:
    host = os.environ.get("FASTCUT_HOST", "127.0.0.1")
    port = int(os.environ.get("FASTCUT_PORT", "8799"))
    httpd = ThreadingHTTPServer((host, port), _Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
