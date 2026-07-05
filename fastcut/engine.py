"""
Top-level engine — orchestrates the tiers with graceful degradation.

`run()` always works (heuristic core). Each optional tier is loaded only if its
deps + inputs are present; if anything is missing the tier is skipped and the
engine keeps going. The returned meta tells the caller exactly which tiers ran,
so the app can surface "Fast Cut (semantic+audio)" vs "Fast Cut (heuristic)".
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict
from typing import List, Optional

import numpy as np

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
        meta = {"semantic": False, "audio": False, "classifier": False, "words": len(words)}
        _write_debug_dump(cfg, words, audio_path, meta, [], [], [],
                          note=f"transcript too short (<{cfg.min_window} words) — engine skipped")
        return [], meta

    t0 = time.time()
    sem, audio, clf, meta = _load_tiers(cfg, audio_path)

    # The ML tiers must NEVER run inside the candidate search: that is one
    # batch-1 forward pass per window pair — thousands of pairs on a 15-minute
    # transcript = minutes on CPU. The tuned lexical core searches alone, then
    # the tiers verify the handful of final cuts in one batched pass below.
    ctx = build_ctx(words)  # shared repeat-count context (built once)
    all_candidates = find_candidates(words, cfg, sem=None, audio=None, ctx=ctx)
    apply_hybrid(all_candidates, words, cfg, classifier=clf)
    candidates = [c for c in all_candidates if c.final_prob >= cfg.accept_threshold]
    cuts = resolve_cuts(candidates, words, cfg)
    extend_cuts_back(cuts, words, cfg, sem=None, audio=None, ctx=ctx)  # swallow chained restarts
    cuts = merge_overlapping_cuts(cuts, words, cfg)                    # tidy overlapping ranges
    cuts, vetoed, verify_log = _verify_cuts(cuts, words, cfg, sem=sem, audio=audio)

    meta["words"] = len(words)
    meta["candidates"] = len(candidates)
    meta["cuts"] = len(cuts)
    meta["vetoed"] = vetoed
    meta["ms"] = int((time.time() - t0) * 1000)
    _write_debug_dump(cfg, words, audio_path, meta, all_candidates, cuts, verify_log)
    return cuts, meta


def _write_debug_dump(
    cfg: Config,
    words: List[WordToken],
    audio_path: Optional[str],
    meta: dict,
    candidates: List,
    cuts: List[Cut],
    verify_log: List[dict],
    note: str = "",
) -> None:
    """Record the full run (inputs, every candidate + features, cuts, verify
    verdicts) so 'why did/didn't it flag X?' is answerable after the fact.
    Best-effort: any failure is swallowed — debugging must never break a cut."""
    if not cfg.debug_dump:
        return
    try:
        path = cfg.debug_path or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "last_run.json"
        )
        rnd = lambda v: round(v, 3) if isinstance(v, float) else v  # noqa: E731
        dump = {
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
            "note": note,
            "meta": meta,
            "audio_path": audio_path or "",
            "audio_exists": bool(audio_path) and os.path.exists(audio_path),
            "config": cfg.to_dict(),
            "candidates": [
                {
                    "i": c.i,
                    "j": c.j,
                    "kind": c.kind,
                    "prob": rnd(c.prob),
                    "final_prob": rnd(c.final_prob),
                    "accepted": c.final_prob >= cfg.accept_threshold,
                    "attempt": " ".join(w.word for w in words[c.i : c.j]),
                    "restart": " ".join(w.word for w in words[c.j : c.j + c.L]),
                    "features": {k: rnd(v) for k, v in asdict(c.feats).items()},
                }
                for c in candidates
            ],
            "cuts": [c.to_json(verbose=True) for c in cuts],
            "verify": verify_log,
            "input_words": [
                {"w": w.word, "s": round(w.start, 3), "e": round(w.end, 3), "conf": round(w.conf, 3)}
                for w in words
            ],
        }
        if os.path.exists(path):  # keep exactly one previous run for comparisons
            try:
                prev = os.path.splitext(path)[0] + ".prev.json"
                os.replace(path, prev)
            except OSError:
                pass
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(dump, fh, ensure_ascii=False, indent=1)
    except Exception:
        pass


def _verify_cuts(
    cuts: List[Cut], words: List[WordToken], cfg: Config, sem=None, audio=None
) -> tuple[List[Cut], int, List[dict]]:
    """Batched ML verification of the final cuts — bounded work: ONE semantic
    encode call for all cuts plus one acoustic comparison per cut.

    Semantic (MiniLM): compare each abandoned attempt against the take that
    replaces it. Same thought re-said -> corroborated (small confidence lift).
    A different thought behind a cut the heuristic was already unsure about ->
    veto the cut (protects real content from over-cuts).
    Acoustic (wav2vec2): matching delivery corroborates, and an acoustic match
    blocks the semantic veto — a reworded retake can read as a "new thought" to
    MiniLM while sounding like the same line being re-taken.
    """
    if not cuts or (sem is None and audio is None):
        return cuts, 0, []

    kept_texts: List[str] = []
    for c in cuts:
        s, jw = c.word_range
        span = max(3, jw - s)
        kept = words[jw : min(len(words), jw + int(1.3 * span) + 3)]
        kept_texts.append(" ".join(w.word for w in kept))

    sem_sims: List[Optional[float]] = [None] * len(cuts)
    if sem is not None:
        try:
            texts: List[str] = []
            for c, kt in zip(cuts, kept_texts):
                texts.extend((c.text, kt))
            vecs = sem.encode(texts)  # one batched forward pass for every cut
            for k in range(len(cuts)):
                sem_sims[k] = float(np.clip(np.dot(vecs[2 * k], vecs[2 * k + 1]), 0.0, 1.0))
        except Exception:
            sem_sims = [None] * len(cuts)

    out: List[Cut] = []
    vetoed = 0
    log: List[dict] = []
    for k, c in enumerate(cuts):
        s, jw = c.word_range
        audio_sim: Optional[float] = None
        if audio is not None and jw < len(words):
            try:
                b_end = min(len(words), jw + max(3, jw - s))
                audio_sim = audio.segment_similarity(
                    words[s].start, words[jw - 1].end, words[jw].start, words[b_end - 1].end
                )
            except Exception:
                audio_sim = None

        acoustic_match = audio_sim is not None and audio_sim >= cfg.verify_corroborate_sim
        corroborated = acoustic_match or (
            sem_sims[k] is not None and sem_sims[k] >= cfg.verify_corroborate_sim
        )
        contradicted = (
            sem_sims[k] is not None
            and sem_sims[k] < cfg.verify_veto_sim
            and c.confidence < cfg.verify_veto_max_conf
            and not acoustic_match
        )
        log.append({
            "text": c.text,
            "cut_start": round(c.cut_start, 3),
            "cut_end": round(c.cut_end, 3),
            "sem_sim": round(sem_sims[k], 3) if sem_sims[k] is not None else None,
            "audio_sim": round(audio_sim, 3) if audio_sim is not None else None,
            "corroborated": corroborated,
            "vetoed": contradicted,
        })
        if contradicted:
            vetoed += 1
            continue
        if corroborated:
            c.confidence = min(0.98, c.confidence + 0.08)
        out.append(c)
    return out, vetoed, log


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
