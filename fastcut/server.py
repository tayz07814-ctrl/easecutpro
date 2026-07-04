"""
Optional persistent sidecar (FastAPI).

The Node side uses the one-shot CLI (fastcut.cli) by default — it's simplest and
the heuristic core starts in ~0.3 s. But when the GPU tiers are on (semantic /
audio / classifier), model loading costs seconds, so you don't want to pay it on
every Fast Cut. Run this once and the models stay warm:

    python -m fastcut.server            # 127.0.0.1:8799

Then POST the same payload the CLI accepts:
    POST /detect   {"words":[...], "audio_path?":..., "config?":{...}, "verbose?":bool}
    -> {"cuts":[{cut_start,cut_end,confidence}], "meta":{...}}

The EaseCutPro Node adapter auto-detects a running sidecar (GET /health) and uses
it; otherwise it falls back to spawning the CLI.
"""

from __future__ import annotations

import os


def build_app():
    from fastapi import FastAPI
    from pydantic import BaseModel
    from typing import Any, Optional

    from .engine import run_json

    app = FastAPI(title="FastCut", version="0.1.0")

    class DetectRequest(BaseModel):
        words: list
        audio_path: Optional[str] = None
        config: Optional[dict] = None
        verbose: bool = False

    @app.get("/health")
    def health() -> dict:
        # report which optional tiers are importable so the UI can show capability
        from . import semantic
        return {"ok": True, "semantic": semantic.available()}

    @app.post("/detect")
    def detect(req: DetectRequest) -> Any:
        return run_json(req.model_dump())

    return app


def main():
    import uvicorn
    host = os.environ.get("FASTCUT_HOST", "127.0.0.1")
    port = int(os.environ.get("FASTCUT_PORT", "8799"))
    uvicorn.run(build_app(), host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
