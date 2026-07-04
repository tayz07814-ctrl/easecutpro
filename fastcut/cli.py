"""
One-shot CLI: JSON in -> JSON out. This is what the Electron / Node side spawns
for the Fast Cut button (no long-running process to manage).

Usage:
    # stdin -> stdout (how the app calls it)
    echo '{"words":[...]}' | python -m fastcut.cli

    # files
    python -m fastcut.cli --in words.json --out cuts.json --verbose
    python -m fastcut.cli --in words.json --audio clip.wav

Exit code is 0 on success, 1 on a hard error (with the error as JSON on stdout
so the caller can show it).
"""

from __future__ import annotations

import argparse
import json
import sys


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="fastcut", description="Retake/repetition detector")
    ap.add_argument("--in", dest="infile", help="input JSON file (default: stdin)")
    ap.add_argument("--out", dest="outfile", help="output JSON file (default: stdout)")
    ap.add_argument("--audio", dest="audio", help="optional WAV path for the audio tier")
    ap.add_argument("--config", dest="config", help="optional Config-overrides JSON file")
    ap.add_argument("--verbose", action="store_true", help="include kind/text/word_range")
    args = ap.parse_args(argv)

    try:
        raw = open(args.infile, "r", encoding="utf-8").read() if args.infile else sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if isinstance(payload, list):       # allow a bare word list
            payload = {"words": payload}
        if args.audio:
            payload["audio_path"] = args.audio
        if args.verbose:
            payload["verbose"] = True
        if args.config:
            payload["config"] = json.load(open(args.config, "r", encoding="utf-8"))

        from .engine import run_json
        result = run_json(payload)
        out = json.dumps(result, ensure_ascii=False)
    except Exception as e:  # surface the error as JSON, don't crash the caller
        out = json.dumps({"error": f"{type(e).__name__}: {e}", "cuts": []})
        if args.outfile:
            open(args.outfile, "w", encoding="utf-8").write(out)
        else:
            sys.stdout.write(out)
        return 1

    if args.outfile:
        open(args.outfile, "w", encoding="utf-8").write(out)
    else:
        sys.stdout.write(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
