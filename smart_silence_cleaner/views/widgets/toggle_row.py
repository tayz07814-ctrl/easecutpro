"""A settings row: title + one-line description + an on/off switch.

Contains a small hand-painted :class:`Switch` (a pill with a sliding, animated
knob) so the control looks modern rather than like a native checkbox. The row
emits :pyattr:`ToggleRow.toggled` when flipped; :meth:`set_checked_silently`
updates the visual state without emitting, so the controller can reflect a
preset's toggle values without bouncing a change back.
"""

from __future__ import annotations

from PySide6.QtCore import (
    Property,
    QEasingCurve,
    QPropertyAnimation,
    QRectF,
    QSize,
    Qt,
    Signal,
)
from PySide6.QtGui import QColor, QMouseEvent, QPainter
from PySide6.QtWidgets import (
    QAbstractButton,
    QHBoxLayout,
    QLabel,
    QVBoxLayout,
    QWidget,
)

from .. import theme


class Switch(QAbstractButton):
    """A compact iOS-style toggle switch with an animated knob.

    The knob position is exposed as the Qt property ``knob`` (0.0 = off, 1.0 =
    on) so a :class:`QPropertyAnimation` can slide it. Being a checkable
    :class:`QAbstractButton`, it inherits ``toggled(bool)`` for free.
    """

    _W = 46
    _H = 26
    _MARGIN = 3

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setCheckable(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFixedSize(self._W, self._H)

        self._knob = 0.0  # 0..1 knob travel
        self._anim = QPropertyAnimation(self, b"knob", self)
        self._anim.setDuration(140)
        self._anim.setEasingCurve(QEasingCurve.Type.InOutCubic)
        self.toggled.connect(self._animate_to)

    # -- animated property ---------------------------------------------------
    def _get_knob(self) -> float:
        return self._knob

    def _set_knob(self, value: float) -> None:
        self._knob = value
        self.update()

    knob = Property(float, _get_knob, _set_knob)  # type: ignore[arg-type]

    def _animate_to(self, checked: bool) -> None:
        """Slide the knob toward the new checked state."""
        self._anim.stop()
        self._anim.setStartValue(self._knob)
        self._anim.setEndValue(1.0 if checked else 0.0)
        self._anim.start()

    # -- silent setter -------------------------------------------------------
    def set_checked_silently(self, checked: bool) -> None:
        """Set the state and snap the knob without emitting ``toggled``."""
        blocked = self.blockSignals(True)
        self.setChecked(checked)
        self.blockSignals(blocked)
        self._anim.stop()
        self._knob = 1.0 if checked else 0.0
        self.update()

    # -- painting ------------------------------------------------------------
    def sizeHint(self) -> QSize:
        return QSize(self._W, self._H)

    def paintEvent(self, _event) -> None:
        """Draw the rounded track and the sliding knob."""
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)

        radius = self._H / 2.0
        track = QRectF(0, 0, self._W, self._H)

        # Track: blend from the 'off' surface to the accent as the knob travels.
        off = theme.track_bg_color()
        on = theme.accent_color()
        track_color = _blend(off, on, self._knob)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(track_color)
        painter.drawRoundedRect(track, radius, radius)

        # Knob: a light circle that travels left -> right.
        diameter = self._H - 2 * self._MARGIN
        travel = self._W - diameter - 2 * self._MARGIN
        x = self._MARGIN + travel * t
        painter.setBrush(theme.text_color())
        painter.drawEllipse(QRectF(x, self._MARGIN, diameter, diameter))
        painter.end()


def _blend(a: QColor, b: QColor, t: float) -> QColor:
    """Linearly blend two :class:`QColor`\\ s (``t`` clamped to [0, 1]).

    A tiny helper kept beside :class:`Switch` (its only user) so the switch track
    can fade between its off and on colours as the knob slides across.
    """
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return QColor(
        round(a.red() + (b.red() - a.red()) * t),
        round(a.green() + (b.green() - a.green()) * t),
        round(a.blue() + (b.blue() - a.blue()) * t),
    )


class ToggleRow(QWidget):
    """A labelled row wrapping a :class:`Switch`.

    Parameters
    ----------
    title:
        Bold name of the option.
    description:
        Muted one-liner explaining what it does.
    checked:
        Initial state.
    parent:
        Standard Qt parent.
    """

    #: Emitted with the new state whenever the switch is flipped by the user.
    toggled = Signal(bool)

    def __init__(
        self,
        title: str,
        description: str,
        checked: bool = False,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self._build(title, description, checked)

    # -- construction --------------------------------------------------------
    def _build(self, title: str, description: str, checked: bool) -> None:
        """Text column on the left, switch pinned to the right."""
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 4, 0, 4)
        layout.setSpacing(12)

        text = QVBoxLayout()
        text.setContentsMargins(0, 0, 0, 0)
        text.setSpacing(2)

        self._title = QLabel(title)
        self._title.setFont(theme.font_label())
        self._title.setStyleSheet(f"color: {theme.TEXT};")

        self._desc = QLabel(description)
        self._desc.setFont(theme.font_caption())
        self._desc.setWordWrap(True)
        self._desc.setStyleSheet(f"color: {theme.TEXT_MUTED};")

        text.addWidget(self._title)
        text.addWidget(self._desc)

        self._switch = Switch()
        self._switch.set_checked_silently(checked)
        self._switch.toggled.connect(self.toggled.emit)

        layout.addLayout(text, 1)
        layout.addWidget(self._switch, 0, Qt.AlignmentFlag.AlignVCenter)

    # -- public API ----------------------------------------------------------
    def is_checked(self) -> bool:
        """Current on/off state."""
        return self._switch.isChecked()

    def set_checked_silently(self, checked: bool) -> None:
        """Reflect ``checked`` without emitting :pyattr:`toggled`."""
        self._switch.set_checked_silently(checked)

    # -- interaction ---------------------------------------------------------
    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        """Clicking anywhere on the row flips the switch (and emits)."""
        if event.button() == Qt.MouseButton.LeftButton and self.rect().contains(event.pos()):
            self._switch.toggle()
        super().mouseReleaseEvent(event)
