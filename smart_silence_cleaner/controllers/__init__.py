"""Controllers: the glue between the PySide6 views and the pure engine.

A controller is the *only* layer allowed to import and call the engine. Views
send it plain-language intents and re-render from the signals it emits; the
engine stays completely UI-agnostic and unit-testable.
"""

from __future__ import annotations

from .silence_controller import SilenceController

__all__ = ["SilenceController"]
