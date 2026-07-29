"""Central visual language for the Smart Silence Cleaner page.

A tiny, dependency-free design system: a dark modern palette, a couple of font
helpers, and small ``*_qss`` functions that return Qt stylesheet strings so every
widget looks like it belongs to the same product. Nothing here talks to the
engine or the controller -- it is pure presentation.

Two flavours of colour live here:

* **Hex strings** (:data:`ACCENT`, :data:`SURFACE` ...) for Qt stylesheets, which
  only understand CSS-like colour literals.
* **``QColor`` accessors** (:func:`accent_color`, :func:`speech_color` ...) for
  the hand-painted :class:`~...widgets.timeline_preview.TimelinePreview`, where a
  ``QPainter`` needs real colour objects (including alpha).

QSS is assembled from *adjacent* string literals -- the ones containing the
selector braces ``{ }`` are plain strings, and only the value fragments are
f-strings -- so we never have to escape braces. Keep that split when editing.
"""

from __future__ import annotations

from PySide6.QtGui import QColor, QFont, QPalette
from PySide6.QtWidgets import QApplication

# --------------------------------------------------------------------------- #
# Palette (hex strings for QSS)                                               #
# --------------------------------------------------------------------------- #
WINDOW_BG: str = "#0E1013"       #: App background, deepest layer.
SURFACE: str = "#171A21"         #: Card / section background.
SURFACE_2: str = "#1F232C"       #: Inset controls: tiles, spin boxes, tracks.
SURFACE_3: str = "#272C37"       #: Hover / raised state.
BORDER: str = "#2A2F3A"          #: Hairline separators and card edges.
BORDER_STRONG: str = "#3A4150"   #: Focused / emphasised borders.

ACCENT: str = "#6E8BFF"          #: Brand accent -- selection, speech, primary.
ACCENT_HOVER: str = "#8AA0FF"    #: Accent, lightened for hover.
ACCENT_PRESSED: str = "#5B78F0"  #: Accent, darkened for press.
ON_ACCENT: str = "#0B1020"       #: Text/icon colour drawn on top of the accent.

TEXT: str = "#EEF1F6"            #: Primary text.
TEXT_MUTED: str = "#98A2B3"      #: Secondary text, captions, descriptions.
TEXT_FAINT: str = "#6B7482"      #: Tertiary text, hints, disabled.

SUCCESS: str = "#37D67A"         #: Positive figures (time saved / reduction).

# Painter-only shades (kept as constants so the accessors below stay in sync).
_SILENCE_TRACK = (34, 39, 50)    #: Kept-silence gap colour in the timeline.
_REMOVED = (46, 52, 66)          #: The "removed" ghost region on the output bar.


# --------------------------------------------------------------------------- #
# Fonts                                                                        #
# --------------------------------------------------------------------------- #
#: Preferred families, best-first. Missing families are skipped by Qt, so this
#: degrades gracefully to whatever modern sans the host provides.
_FAMILIES: tuple[str, ...] = (
    "Inter",
    "SF Pro Text",
    "Segoe UI",
    "Helvetica Neue",
    "Roboto",
    "Arial",
    "sans-serif",
)


def font(size: int, weight: QFont.Weight = QFont.Weight.Normal) -> QFont:
    """Build a themed :class:`QFont` at ``size`` px with the given ``weight``.

    The point/pixel size is set in *pixels* for consistent layout across DPIs
    within this demo; production code may prefer point sizes.
    """
    f = QFont()
    f.setFamilies(list(_FAMILIES))
    f.setPixelSize(size)
    f.setWeight(weight)
    return f


def font_title() -> QFont:
    """Big page / section heading."""
    return font(20, QFont.Weight.DemiBold)


def font_subtitle() -> QFont:
    """Muted line under a heading."""
    return font(13, QFont.Weight.Normal)


def font_body() -> QFont:
    """Default body text (also the application-wide default)."""
    return font(13, QFont.Weight.Normal)


def font_label() -> QFont:
    """Control label / card title."""
    return font(14, QFont.Weight.DemiBold)


def font_caption() -> QFont:
    """Small caption under sliders and stat tiles."""
    return font(11, QFont.Weight.Normal)


def font_stat() -> QFont:
    """The large number inside a stat tile."""
    return font(22, QFont.Weight.Bold)


# --------------------------------------------------------------------------- #
# QColor accessors (for the hand-painted preview + switch)                     #
# --------------------------------------------------------------------------- #
def accent_color(alpha: int = 255) -> QColor:
    """The brand accent as a :class:`QColor` (optional 0-255 ``alpha``)."""
    c = QColor(ACCENT)
    c.setAlpha(alpha)
    return c


def speech_color(alpha: int = 255) -> QColor:
    """Colour of a spoken-word block in the timeline (the accent)."""
    return accent_color(alpha)


def silence_color() -> QColor:
    """Colour of a kept-silence gap in the timeline (a soft track)."""
    return QColor(*_SILENCE_TRACK)


def removed_color() -> QColor:
    """Colour of the ghosted 'removed' region on the processed bar."""
    return QColor(*_REMOVED)


def track_bg_color() -> QColor:
    """Neutral background used behind a timeline bar."""
    return QColor(SURFACE_2)


def text_color() -> QColor:
    """Primary text as a :class:`QColor` (for painted labels)."""
    return QColor(TEXT)


def text_muted_color() -> QColor:
    """Muted text as a :class:`QColor` (for painted captions)."""
    return QColor(TEXT_MUTED)


def border_color() -> QColor:
    """Hairline border as a :class:`QColor`."""
    return QColor(BORDER)


# --------------------------------------------------------------------------- #
# Stylesheet fragments                                                         #
# --------------------------------------------------------------------------- #
def card_qss(radius: int = 16) -> str:
    """Rounded surface used by :class:`~...widgets.section.Section`."""
    return (
        "QFrame#Card {"
        f"background-color: {SURFACE};"
        f"border: 1px solid {BORDER};"
        f"border-radius: {radius}px;"
        "}"
    )


def tile_qss(radius: int = 12) -> str:
    """Inset tile used by stat / export read-outs."""
    return (
        "QFrame#Tile {"
        f"background-color: {SURFACE_2};"
        f"border: 1px solid {BORDER};"
        f"border-radius: {radius}px;"
        "}"
    )


def chip_qss() -> str:
    """Small accent 'pill' (e.g. the reduction badge in the preview header)."""
    return (
        "QLabel#Chip {"
        f"background-color: rgba(110, 139, 255, 0.16);"
        f"color: {ACCENT_HOVER};"
        f"border: 1px solid rgba(110, 139, 255, 0.35);"
        "border-radius: 11px;"
        "padding: 3px 12px;"
        "}"
    )


def primary_button_qss() -> str:
    """The big, prominent Apply button."""
    return (
        "QPushButton {"
        f"background-color: {ACCENT};"
        f"color: {ON_ACCENT};"
        "border: none;"
        "border-radius: 13px;"
        "padding: 14px 30px;"
        "font-weight: 700;"
        "}"
        "QPushButton:hover {"
        f"background-color: {ACCENT_HOVER};"
        "}"
        "QPushButton:pressed {"
        f"background-color: {ACCENT_PRESSED};"
        "}"
        "QPushButton:disabled {"
        f"background-color: {SURFACE_3};"
        f"color: {TEXT_FAINT};"
        "}"
    )


def link_button_qss() -> str:
    """Flat, text-only button (the Advanced disclosure header)."""
    return (
        "QPushButton {"
        "background: transparent;"
        f"color: {TEXT};"
        "border: none;"
        "padding: 6px 2px;"
        "text-align: left;"
        "font-weight: 600;"
        "}"
        "QPushButton:hover {"
        f"color: {ACCENT_HOVER};"
        "}"
    )


def slider_qss() -> str:
    """Groove + handle styling for the creator sliders."""
    return (
        "QSlider::groove:horizontal {"
        f"background: {SURFACE_2};"
        "height: 6px;"
        "border-radius: 3px;"
        "}"
        "QSlider::sub-page:horizontal {"
        f"background: {ACCENT};"
        "height: 6px;"
        "border-radius: 3px;"
        "}"
        "QSlider::add-page:horizontal {"
        f"background: {SURFACE_2};"
        "height: 6px;"
        "border-radius: 3px;"
        "}"
        "QSlider::handle:horizontal {"
        f"background: {TEXT};"
        f"border: 3px solid {ACCENT};"
        "width: 16px;"
        "height: 16px;"
        "margin: -7px 0;"
        "border-radius: 11px;"
        "}"
        "QSlider::handle:horizontal:hover {"
        f"border-color: {ACCENT_HOVER};"
        "}"
    )


def spinbox_qss() -> str:
    """Advanced-panel numeric inputs."""
    return (
        "QSpinBox {"
        f"background-color: {SURFACE_2};"
        f"color: {TEXT};"
        f"border: 1px solid {BORDER};"
        "border-radius: 8px;"
        "padding: 6px 8px;"
        "min-width: 96px;"
        "}"
        "QSpinBox:focus {"
        f"border: 1px solid {ACCENT};"
        "}"
        "QSpinBox::up-button, QSpinBox::down-button {"
        "width: 16px;"
        "border: none;"
        f"background: {SURFACE_3};"
        "}"
        "QSpinBox::up-button {border-top-right-radius: 8px;}"
        "QSpinBox::down-button {border-bottom-right-radius: 8px;}"
    )


def app_qss() -> str:
    """Application-wide base stylesheet (backgrounds, text, scrollbars)."""
    return (
        "QWidget {"
        f"background-color: {WINDOW_BG};"
        f"color: {TEXT};"
        "}"
        "QToolTip {"
        f"background-color: {SURFACE_3};"
        f"color: {TEXT};"
        f"border: 1px solid {BORDER_STRONG};"
        "padding: 4px 8px;"
        "border-radius: 6px;"
        "}"
        "QScrollArea {border: none;}"
        "QScrollBar:vertical {"
        f"background: {WINDOW_BG};"
        "width: 12px;"
        "margin: 0;"
        "}"
        "QScrollBar::handle:vertical {"
        f"background: {SURFACE_3};"
        "min-height: 40px;"
        "border-radius: 6px;"
        "}"
        "QScrollBar::handle:vertical:hover {"
        f"background: {BORDER_STRONG};"
        "}"
        "QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {height: 0;}"
        "QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {background: transparent;}"
    )


def apply_theme(app: QApplication) -> None:
    """Install the theme on a running :class:`QApplication`.

    Sets the Fusion base style (so the stylesheet renders identically on every
    platform), the default font, a matching :class:`QPalette` for the handful of
    native bits stylesheets miss, and the global stylesheet.
    """
    app.setStyle("Fusion")
    app.setFont(font_body())

    pal = QPalette()
    pal.setColor(QPalette.ColorRole.Window, QColor(WINDOW_BG))
    pal.setColor(QPalette.ColorRole.Base, QColor(SURFACE_2))
    pal.setColor(QPalette.ColorRole.AlternateBase, QColor(SURFACE))
    pal.setColor(QPalette.ColorRole.Text, QColor(TEXT))
    pal.setColor(QPalette.ColorRole.WindowText, QColor(TEXT))
    pal.setColor(QPalette.ColorRole.Button, QColor(SURFACE_2))
    pal.setColor(QPalette.ColorRole.ButtonText, QColor(TEXT))
    pal.setColor(QPalette.ColorRole.Highlight, QColor(ACCENT))
    pal.setColor(QPalette.ColorRole.HighlightedText, QColor(ON_ACCENT))
    pal.setColor(QPalette.ColorRole.ToolTipBase, QColor(SURFACE_3))
    pal.setColor(QPalette.ColorRole.ToolTipText, QColor(TEXT))
    app.setPalette(pal)

    app.setStyleSheet(app_qss())
