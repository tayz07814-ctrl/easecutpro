"""A collapsed-by-default disclosure exposing the raw engine parameters.

Power users click the header to reveal spin boxes for the seven millisecond
knobs the engine actually consumes (minimum gap, target pause, sentence pause,
comma pause, merge gap, padding before, padding after). Editing any one emits
:pyattr:`AdvancedPanel.paramChanged` as ``(field_name, value_ms)`` -- the field
name matches a :class:`SilenceSettings` attribute, so the controller can apply it
with a single ``settings.copy(**{name: value})``.

:meth:`set_values_silently` pushes the current settings into the boxes without
emitting, so the panel stays in sync with the sliders/preset without echoing a
change back to the controller.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QGridLayout,
    QLabel,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from .. import theme

if TYPE_CHECKING:  # annotations only -- never imported at runtime
    from ...models.settings import SilenceSettings


#: (display label, SilenceSettings field, min ms, max ms) for each spin box.
_FIELDS: tuple[tuple[str, str, int, int], ...] = (
    ("Minimum gap", "min_gap_ms", 0, 2000),
    ("Target pause", "target_pause_ms", 0, 1000),
    ("Sentence pause", "sentence_pause_ms", 0, 1500),
    ("Comma pause", "comma_pause_ms", 0, 1500),
    ("Merge gap", "merge_gap_ms", 0, 1000),
    ("Padding before", "pad_before_ms", 0, 1000),
    ("Padding after", "pad_after_ms", 0, 1000),
)


class AdvancedPanel(QWidget):
    """A disclosure widget wrapping the raw-parameter spin boxes."""

    #: Emitted as ``(field_name, value_ms)`` when a spin box is edited.
    paramChanged = Signal(str, int)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._expanded = False
        self._boxes: dict[str, QSpinBox] = {}

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(10)

        self._header = QPushButton(self._header_text())
        self._header.setStyleSheet(theme.link_button_qss())
        self._header.setCursor(Qt.CursorShape.PointingHandCursor)
        self._header.clicked.connect(self._toggle)
        layout.addWidget(self._header)

        self._content = self._build_content()
        self._content.setVisible(False)
        layout.addWidget(self._content)

    # -- construction --------------------------------------------------------
    def _build_content(self) -> QWidget:
        """Grid of ``label + spin box`` pairs, two pairs per row."""
        content = QWidget()
        grid = QGridLayout(content)
        grid.setContentsMargins(0, 4, 0, 0)
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(12)

        for index, (label_text, name, low, high) in enumerate(_FIELDS):
            row = index // 2
            pair = index % 2
            col = pair * 2

            label = QLabel(label_text)
            label.setFont(theme.font_caption())
            label.setStyleSheet(f"color: {theme.TEXT_MUTED};")

            box = QSpinBox()
            box.setRange(low, high)
            box.setSingleStep(10)
            box.setSuffix(" ms")
            box.setStyleSheet(theme.spinbox_qss())
            box.valueChanged.connect(
                lambda value, field=name: self.paramChanged.emit(field, int(value))
            )

            self._boxes[name] = box
            grid.addWidget(label, row, col)
            grid.addWidget(box, row, col + 1)

        grid.setColumnStretch(1, 1)
        grid.setColumnStretch(3, 1)
        return content

    # -- disclosure ----------------------------------------------------------
    def _header_text(self) -> str:
        arrow = "▾" if self._expanded else "▸"  # down / right triangle
        return f"{arrow}  Advanced settings"

    def _toggle(self) -> None:
        """Expand or collapse the spin-box grid."""
        self._expanded = not self._expanded
        self._content.setVisible(self._expanded)
        self._header.setText(self._header_text())

    # -- public API ----------------------------------------------------------
    def set_values_silently(self, settings: "SilenceSettings") -> None:
        """Load every spin box from ``settings`` without emitting a change."""
        for name, box in self._boxes.items():
            value = int(round(float(getattr(settings, name))))
            blocked = box.blockSignals(True)
            box.setValue(max(box.minimum(), min(box.maximum(), value)))
            box.blockSignals(blocked)
