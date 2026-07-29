"""Reusable, self-contained PySide6 widgets for the Smart Silence page.

Every widget here is presentation-only: it renders what it is given and emits a
single, plain-language *intent* signal (a card was clicked, a slider moved, a
toggle flipped, a raw parameter was edited). None of them import the engine or
the controller, so they can be reused on any page or previewed in isolation.
"""

from __future__ import annotations

from .advanced_panel import AdvancedPanel
from .creator_slider import CreatorSlider
from .export_preview import ExportPreview
from .mode_card import ModeCard
from .section import Section, divider
from .stats_panel import StatsPanel
from .timeline_preview import TimelinePreview
from .toggle_row import ToggleRow

__all__ = [
    "AdvancedPanel",
    "CreatorSlider",
    "ExportPreview",
    "ModeCard",
    "Section",
    "StatsPanel",
    "TimelinePreview",
    "ToggleRow",
    "divider",
]
