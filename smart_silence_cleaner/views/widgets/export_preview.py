"""A compact 'before -> after' export estimate band.

Shows the original duration, an arrow, the estimated output duration, and a
reduction read-out (percentage + absolute time saved). Driven by
:meth:`ExportPreview.set_stats` from the plan's :class:`Stats`; like the other
read-outs it formats through the stats object's own helpers and never imports
the engine at runtime.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QHBoxLayout, QLabel, QVBoxLayout, QWidget

from .. import theme

if TYPE_CHECKING:  # annotations only -- never imported at runtime
    from ...engine.stats import Stats


class _Metric(QWidget):
    """A small caption-over-value stack used for the two durations."""

    def __init__(self, caption: str, value_color: str = theme.TEXT) -> None:
        super().__init__()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(2)

        self._caption = QLabel(caption)
        self._caption.setFont(theme.font_caption())
        self._caption.setStyleSheet(f"color: {theme.TEXT_MUTED};")

        self._value = QLabel("--")
        self._value.setFont(theme.font_stat())
        self._value.setStyleSheet(f"color: {value_color};")

        layout.addWidget(self._caption)
        layout.addWidget(self._value)

    def set_value(self, text: str) -> None:
        self._value.setText(text)


class ExportPreview(QWidget):
    """Original duration -> estimated output duration + estimated reduction."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(16)

        self._original = _Metric("Original duration", theme.TEXT)
        self._output = _Metric("Estimated output", theme.ACCENT_HOVER)

        arrow = QLabel("→")  # rightwards arrow
        arrow.setFont(theme.font(24))
        arrow.setStyleSheet(f"color: {theme.TEXT_FAINT};")
        arrow.setAlignment(Qt.AlignmentFlag.AlignCenter)

        # Reduction read-out, right-aligned.
        reduction = QVBoxLayout()
        reduction.setContentsMargins(0, 0, 0, 0)
        reduction.setSpacing(2)

        cap = QLabel("Estimated reduction")
        cap.setFont(theme.font_caption())
        cap.setStyleSheet(f"color: {theme.TEXT_MUTED};")
        cap.setAlignment(Qt.AlignmentFlag.AlignRight)

        self._reduction = QLabel("--")
        self._reduction.setFont(theme.font_stat())
        self._reduction.setStyleSheet(f"color: {theme.SUCCESS};")
        self._reduction.setAlignment(Qt.AlignmentFlag.AlignRight)

        reduction.addWidget(cap)
        reduction.addWidget(self._reduction)

        row.addWidget(self._original)
        row.addWidget(arrow)
        row.addWidget(self._output)
        row.addStretch(1)
        row.addLayout(reduction)

    # -- public API ----------------------------------------------------------
    def set_stats(self, stats: "Stats") -> None:
        """Refresh the durations and the reduction from ``stats``."""
        self._original.set_value(stats.fmt_duration(stats.original_duration_ms))
        self._output.set_value(stats.fmt_duration(stats.output_duration_ms))
        self._reduction.setText(f"{stats.percent_removed_str}  ·  {stats.time_saved_str}")
