"""
Fast Cut — a hybrid heuristic + ML retake / repetition detection engine.

Public API:
    from fastcut import Config, run, run_json
    from fastcut.types import WordToken, words_from_json
"""

from .config import Config, ScoringWeights
from .engine import run, run_json
from .types import Cut, WordToken, words_from_json

__all__ = [
    "Config", "ScoringWeights", "run", "run_json",
    "Cut", "WordToken", "words_from_json",
]

__version__ = "0.1.0"
