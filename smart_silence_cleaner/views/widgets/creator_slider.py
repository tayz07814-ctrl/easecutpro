"""A plain-language labelled slider (0-100) with left/right captions.

The creator never sees milliseconds here: a title sits above the track and two
captions flank it (e.g. *Keep more pauses* ... *Remove more pauses*). The widget
emits :pyattr:`valueChanged` as the user drags. :meth:`set_value_silently` moves
the handle *without* emitting -- used when the controller repositions the slider
to match a freshly chosen preset, so no feedback loop occurs.
"""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QSlider,
    QVBoxLayout,
    QWidget,
)

from .. import theme


class CreatorSlider(QWidget):
    """A 0-100 slider with a title and two end captions.

    Parameters
    ----------
    title:
        Bold label above the track.
    left_caption, right_caption:
        Muted hints under the two ends of the track.
    value:
        Initial handle position (0-100).
    parent:
        Standard Qt parent.
    """

    #: Emitted (0-100) whenever the user moves the handle.
    valueChanged = Signal(int)

    def __init__(
        self,
        title: str,
        left_caption: str,
        right_caption: str,
        value: int = 50,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._build(title, left_caption, right_caption, value)

    # -- construction --------------------------------------------------------
    def _build(self, title: str, left: str, right: str, value: int) -> None:
        """Assemble title row, slider track and the caption row."""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        self._title = QLabel(title)
        self._title.setFont(theme.font_label())
        self._title.setStyleSheet(f"color: {theme.TEXT};")
        layout.addWidget(self._title)

        self._slider = QSlider(Qt.Orientation.Horizontal)
        self._slider.setMinimum(0)
        self._slider.setMaximum(100)
        self._slider.setSingleStep(1)
        self._slider.setPageStep(10)
        self._slider.setValue(int(value))
        self._slider.setStyleSheet(theme.slider_qss())
        # Relay the inner slider's signal as our own public signal.
        self._slider.valueChanged.connect(self.valueChanged.emit)
        layout.addWidget(self._slider)

        captions = QHBoxLayout()
        captions.setContentsMargins(0, 0, 0, 0)
        captions.setSpacing(8)

        self._left = QLabel(left)
        self._left.setFont(theme.font_caption())
        self._left.setStyleSheet(f"color: {theme.TEXT_MUTED};")

        self._right = QLabel(right)
        self._right.setFont(theme.font_caption())
        self._right.setStyleSheet(f"color: {theme.TEXT_MUTED};")
        self._right.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)

        captions.addWidget(self._left)
        captions.addStretch(1)
        captions.addWidget(self._right)
        layout.addLayout(captions)

    # -- public API ----------------------------------------------------------
    def value(self) -> int:
        """Current handle position (0-100)."""
        return self._slider.value()

    def set_value_silently(self, value: int) -> None:
        """Move the handle to ``value`` (0-100) without emitting a signal.

        The inner slider's signals are blocked for the duration so the relay in
        :meth:`_build` stays quiet -- the controller uses this to sync the slider
        to a preset without re-triggering a settings change.
        """
        clamped = max(0, min(100, int(value)))
        blocked = self._slider.blockSignals(True)
        self._slider.setValue(clamped)
        self._slider.blockSignals(blocked)
