"""
Top-level engine — orchestrates the tiers with graceful degradation.

`run()` always works (heuristic core). Each optional tier is loaded only if its
deps + inputs are present; if anything is missing the tier is skipped and the
engine keeps going. The returned meta tells the caller exactly which tiers ran,
so the app can surface "Fast Cut (semantic+audio)" vs "Fast Cut (heuristic)".
"""

from __future__ import annotations

from typing import List, Optional

from .config import Config
from .detect import build_ctx, extend_cuts_back, find_candidates, merge_overlapping_cuts, resolve_cuts
from .hybrid import apply_hybrid
from .types import Cut, WordToken, words_from_json


def _load_tiers(cfg: Config, audio_path: Optional[str]):
    sem = audio = clf = None
    meta = {"semantic": False, "audio": False, "classifier": False, "device": "cpu"}

    if cfg.use_semantic:
        from . import semantic
        if semantic.available():
            sem = semantic.SemanticModel.try_load(cfg.semantic_model, cfg.device)
            if sem is not None:
                meta["semantic"] = True
                meta["device"] = sem.device

    if cfg.use_audio and audio_path:
        try:
            from .audio import AudioEmbedder
            audio = AudioEmbedder.try_load(cfg.audio_model, audio_path, cfg.device)
            meta["audio"] = audio is not None
        except Exception:
            audio = None

    if cfg.use_classifier and cfg.classifier_path:
        try:
            from .classifier import RetakeClassifier
            clf = RetakeClassifier.try_load(cfg.classifier_path, cfg.device)
            meta["classifier"] = clf is not None
        except Exception:
            clf = None

    return sem, audio, clf, meta


def run(
    words: List[WordToken],
    cfg: Optional[Config] = None,
    audio_path: Optional[str] = None,
) -> tuple[List[Cut], dict]:
    cfg = cfg or Config()
    if len(words) < cfg.min_window:
        return [], {"semantic": False, "audio": False, "classifier": False, "words": len(words)}

    sem, audio, clf, meta = _load_tiers(cfg, audio_path)

    ctx = build_ctx(words)  # shared repeat-count context (built once)
    candidates = find_candidates(words, cfg, sem=sem, audio=audio, ctx=ctx)
    apply_hybrid(candidates, words, cfg, classifier=clf)
    candidates = [c for c in candidates if c.final_prob >= cfg.accept_threshold]
    cuts = resolve_cuts(candidates, words, cfg)
    extend_cuts_back(cuts, words, cfg, sem=sem, audio=audio, ctx=ctx)  # swallow chained restarts
    cuts = merge_overlapping_cuts(cuts, words, cfg)                    # tidy overlapping ranges

    meta["words"] = len(words)
    meta["candidates"] = len(candidates)
    meta["cuts"] = len(cuts)
    return cuts, meta


def run_json(payload: dict) -> dict:
    """Engine entry point for the CLI / HTTP server.

    payload = {
        "words": [{"word"|"text", "start", "end", "conf"?}, ...],
        "audio_path": "optional/path.wav",
        "config": { ...optional Config overrides... },
        "verbose": false
    }
    -> { "cuts": [{cut_start, cut_end, confidence}, ...], "meta": {...} }
    """
    cfg = Config.from_dict(payload.get("config"))
    words = words_from_json(payload.get("words", []))
    audio_path = payload.get("audio_path")
    verbose = bool(payload.get("verbose", False))

    cuts, meta = run(words, cfg, audio_path=audio_path)
    return {"cuts": [c.to_json(verbose=verbose) for c in cuts], "meta": meta}
