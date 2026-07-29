"""A tidy grid of stat tiles fed by the plan's :class:`Stats`.

Seven read-outs: average pause, longest pause, pauses removed, time saved,
percentage removed, speech duration and silence duration. Each is a small inset
tile with a big value and a muted caption. :meth:`StatsPanel.set_stats` refreshes
them from a :class:`Stats` object -- the view formats numbers using that object's
own helpers (``fmt_duration`` / ``time_saved_str`` / ``percent_removed_str``),
so it needs no import from the engine at runtime.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtWidgets import QFrame, QGridLayout, QLabel, QVBoxLayout, QWidget

from .. import theme

if TYPE_CHECKING:  # annotations only -- never imported at runtime
    from ...engine.stats import Stats


class StatTile(QFrame):
    """A single value + caption read-out."""

    def __init__(self, caption: str, value_color: str = theme.TEXT) -> None:
        super().__init__()
        self.setObjectName("Tile")
        self.setStyleSheet(theme.tile_qss())

        layout = QVBoxLayout(self)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(2)

        self._value = QLabel("--")
        self._value.setFont(theme.font_stat())
        self._value.setStyleSheet(f"color: {value_color};")

        self._caption = QLabel(caption)
        self._caption.setFont(theme.font_caption())
        self._caption.setStyleSheet(f"color: {theme.TEXT_MUTED};")

        layout.addWidget(self._value)
        layout.addWidget(self._caption)

    def set_value(self, text: str) -> None:
        """Update the big number/string."""
        self._value.setText(text)


class StatsPanel(QWidget):
    """A responsive grid of :class:`StatTile`\\ s."""

    _COLUMNS = 4

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        grid = QGridLayout(self)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(12)
        grid.setVerticalSpacing(12)

        # (key, caption, value colour) in display order. Time saved and the
        # reduction percentage are accented so the eye lands on them first.
        specs: list[tuple[str, str, str]] = [
            ("saved", "Time saved", theme.SUCCESS),
            ("percent", "Percentage removed", theme.ACCENT_HOVER),
            ("pauses", "Pauses removed", theme.TEXT),
            ("average", "Average pause", theme.TEXT),
            ("longest", "Longest pause", theme.TEXT),
            ("speech", "Speech duration", theme.TEXT),
            ("silence", "Silence duration", theme.TEXT),
        ]

        self._tiles: dict[str, StatTile] = {}
        for index, (key, caption, color) in enumerate(specs):
            tile = StatTile(caption, color)
            self._tiles[key] = tile
            grid.addWidget(tile, index // self._COLUMNS, index % self._COLUMNS)

        for column in range(self._COLUMNS):
            grid.setColumnStretch(column, 1)

    # -- public API ----------------------------------------------------------
    def set_stats(self, stats: "Stats") -> None:
        """Refresh every tile from ``stats`` (formatted via its own helpers)."""
        self._tiles["saved"].set_value(stats.time_saved_str)
        self._tiles["percent"].set_value(stats.percent_removed_str)
        self._tiles["pauses"].set_value(str(stats.pauses_removed))
        self._tiles["average"].set_value(stats.fmt_duration(stats.average_pause_ms))
        self._tiles["longest"].set_value(stats.fmt_duration(stats.longest_pause_ms))
        self._tiles["speech"].set_value(stats.fmt_duration(stats.speech_duration_ms))
        self._tiles["silence"].set_value(stats.fmt_duration(stats.silence_duration_ms))
