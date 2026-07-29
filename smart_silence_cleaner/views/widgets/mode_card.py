"""A big, selectable preset card: icon + title + description.

One :class:`ModeCard` is shown per preset from
:meth:`~...models.presets.PresetManager.all`. Clicking it emits
:pyattr:`ModeCard.clicked` with the preset id -- the *only* thing this widget
tells the outside world. The selected state (accent border + soft glow) is a
pure visual property driven by :meth:`set_selected`; the controller decides
which card is selected, never the card itself.
"""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QMouseEvent
from PySide6.QtWidgets import (
    QGraphicsDropShadowEffect,
    QLabel,
    QVBoxLayout,
    QWidget,
)

from .. import theme
from ...models.presets import Preset


class ModeCard(QWidget):
    """A clickable card standing in for one editing preset.

    Parameters
    ----------
    preset:
        The preset this card represents. Its ``icon``, ``title`` and
        ``description`` are shown; its ``id`` is what :pyattr:`clicked` carries.
    parent:
        Standard Qt parent.
    """

    #: Emitted with the preset id when the card is clicked.
    clicked = Signal(str)

    def __init__(self, preset: Preset, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._preset_id: str = preset.id
        self._selected: bool = False

        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setMinimumWidth(176)
        self.setMinimumHeight(148)

        self._build(preset)
        self._install_glow()
        self._refresh_style()

    # -- construction --------------------------------------------------------
    def _build(self, preset: Preset) -> None:
        """Lay out the icon, title and wrapping description."""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(8)

        self._icon = QLabel(preset.icon)
        self._icon.setFont(theme.font(30))
        self._icon.setStyleSheet("background: transparent;")
        layout.addWidget(self._icon)

        self._title = QLabel(preset.title)
        self._title.setFont(theme.font_label())
        self._title.setWordWrap(True)
        self._title.setStyleSheet(f"color: {theme.TEXT}; background: transparent;")
        layout.addWidget(self._title)

        self._desc = QLabel(preset.description)
        self._desc.setFont(theme.font_caption())
        self._desc.setWordWrap(True)
        self._desc.setStyleSheet(f"color: {theme.TEXT_MUTED}; background: transparent;")
        layout.addWidget(self._desc)
        layout.addStretch(1)

    def _install_glow(self) -> None:
        """Attach a drop shadow used as an accent glow when selected."""
        self._glow = QGraphicsDropShadowEffect(self)
        self._glow.setBlurRadius(28)
        self._glow.setOffset(0, 0)
        self._glow.setColor(theme.accent_color(0))  # invisible until selected
        self.setGraphicsEffect(self._glow)

    # -- state ---------------------------------------------------------------
    @property
    def preset_id(self) -> str:
        """The id of the preset this card represents."""
        return self._preset_id

    def set_selected(self, selected: bool) -> None:
        """Toggle the selected look (accent border + glow). Emits nothing."""
        if selected == self._selected:
            return
        self._selected = selected
        self._refresh_style()

    def _refresh_style(self) -> None:
        """Repaint border/background and glow for the current state."""
        if self._selected:
            border = theme.ACCENT
            background = "rgba(110, 139, 255, 0.10)"
            self._glow.setColor(theme.accent_color(150))
        else:
            border = theme.BORDER
            background = theme.SURFACE_2
            self._glow.setColor(theme.accent_color(0))
        self.setStyleSheet(
            "ModeCard {"
            f"background-color: {background};"
            f"border: 2px solid {border};"
            "border-radius: 14px;"
            "}"
        )

    # -- interaction ---------------------------------------------------------
    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        """Emit :pyattr:`clicked` for a left-button release inside the card."""
        if event.button() == Qt.MouseButton.LeftButton and self.rect().contains(event.pos()):
            self.clicked.emit(self._preset_id)
        super().mouseReleaseEvent(event)
