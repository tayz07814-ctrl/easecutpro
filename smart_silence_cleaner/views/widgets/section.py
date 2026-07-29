"""A titled card container that keeps the page visually tidy.

:class:`Section` is a rounded surface with an optional title, an optional muted
subtitle, and a slot on the right of its header (used, for example, by the live
preview to show a reduction badge). Content is added with :meth:`add` /
:meth:`add_layout`. It holds no state and knows nothing about the engine.
"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QLayout,
    QVBoxLayout,
    QWidget,
)

from .. import theme


class Section(QFrame):
    """A card with a header (title + optional subtitle + optional trailing widget).

    Parameters
    ----------
    title:
        Heading text. Empty string hides the whole header row.
    subtitle:
        Optional muted line under the title.
    parent:
        Standard Qt parent.
    """

    def __init__(
        self,
        title: str = "",
        subtitle: str = "",
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self.setObjectName("Card")
        self.setStyleSheet(theme.card_qss())

        self._outer = QVBoxLayout(self)
        self._outer.setContentsMargins(20, 18, 20, 20)
        self._outer.setSpacing(14)

        self._header: QHBoxLayout | None = None
        if title or subtitle:
            self._build_header(title, subtitle)

        # Where callers drop their content.
        self._body = QVBoxLayout()
        self._body.setContentsMargins(0, 0, 0, 0)
        self._body.setSpacing(12)
        self._outer.addLayout(self._body)

    # -- construction helpers ------------------------------------------------
    def _build_header(self, title: str, subtitle: str) -> None:
        """Create the title/subtitle column plus a right-hand slot."""
        self._header = QHBoxLayout()
        self._header.setContentsMargins(0, 0, 0, 0)
        self._header.setSpacing(12)

        titles = QVBoxLayout()
        titles.setContentsMargins(0, 0, 0, 0)
        titles.setSpacing(2)

        if title:
            label = QLabel(title)
            label.setFont(theme.font_title())
            label.setStyleSheet(f"color: {theme.TEXT};")
            titles.addWidget(label)
        if subtitle:
            sub = QLabel(subtitle)
            sub.setFont(theme.font_subtitle())
            sub.setStyleSheet(f"color: {theme.TEXT_MUTED};")
            sub.setWordWrap(True)
            titles.addWidget(sub)

        self._header.addLayout(titles)
        self._header.addStretch(1)
        self._outer.addLayout(self._header)

    # -- public API ----------------------------------------------------------
    def add(self, widget: QWidget) -> None:
        """Append a widget to the section body."""
        self._body.addWidget(widget)

    def add_layout(self, layout: QLayout) -> None:
        """Append a nested layout to the section body."""
        self._body.addLayout(layout)

    def add_spacing(self, px: int) -> None:
        """Insert fixed vertical spacing in the body."""
        self._body.addSpacing(px)

    def set_header_widget(self, widget: QWidget) -> None:
        """Place ``widget`` at the trailing (right) edge of the header.

        No-op when the section was created without a header.
        """
        if self._header is not None:
            self._header.addWidget(widget, 0, Qt.AlignmentFlag.AlignVCenter)

    def body(self) -> QVBoxLayout:
        """The body layout, for callers that need direct access."""
        return self._body


def divider() -> QFrame:
    """A thin horizontal hairline, handy between groups inside a section."""
    line = QFrame()
    line.setFixedHeight(1)
    line.setStyleSheet(f"background-color: {theme.BORDER}; border: none;")
    return line
