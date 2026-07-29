"""A hand-painted before/after timing visualization -- no media, just paint.

Two horizontal bars are drawn with a :class:`QPainter`:

* **Original** -- the full transcript at scale ``width / duration``. Spoken words
  are solid accent blocks; the gaps between them are the light silence track.
* **Processed** -- the same time scale, but the surviving KEEP ranges are laid
  end-to-end from the left, so the filled portion is visibly shorter. The faint
  ghost to its right is exactly the removed time, so the eye reads the saving
  directly. Speech inside the kept ranges stays highlighted.

The widget is dumb: :meth:`set_data` takes ``(words, plan)`` from the controller
and repaints instantly. It never imports the engine and computes nothing beyond
pixel geometry -- all timing decisions arrive pre-made inside the ``plan``.
"""

from __future__ import annotations

from typing import Sequence

from PySide6.QtCore import QRectF, QSize, Qt
from PySide6.QtGui import QPainter, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from .. import theme
from ...models.edl import SilencePlan
from ...models.word import Word

# Geometry constants (pixels).
_CAPTION_H = 16
_CAP_BAR_GAP = 6
_BAR_H = 30
_GROUP_GAP = 18
_PAD_X = 1
_BAR_RADIUS = 7.0
_SPEECH_RADIUS = 2.5
_MIN_BLOCK_W = 2.0


def _fmt_ms(ms: float) -> str:
    """Format milliseconds like the engine's ``Stats.fmt_duration`` (local copy).

    Kept private here so the view needs no import from the engine package.
    """
    ms = max(0.0, ms)
    secs = ms / 1000.0
    if secs < 60:
        return f"{secs:.1f}s"
    m, s = divmod(int(round(secs)), 60)
    return f"{m}:{s:02d}"


class TimelinePreview(QWidget):
    """Paints the Original vs Processed timing bars for the current plan."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._words: list[Word] = []
        self._plan: SilencePlan | None = None
        self._duration_ms: float = 0.0

        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setMinimumHeight(self.sizeHint().height())

    # -- data ----------------------------------------------------------------
    def set_data(self, words: Sequence[Word], plan: SilencePlan | None) -> None:
        """Replace the displayed data and repaint immediately.

        Parameters
        ----------
        words:
            The transcript being visualised (drives the Original bar).
        plan:
            The current :class:`SilencePlan`; its ``keeps`` drive the Processed
            bar and its ``original_duration_ms`` sets the horizontal scale. May
            be ``None`` before the first plan arrives.
        """
        self._words = list(words)
        self._plan = plan
        if plan is not None:
            self._duration_ms = float(plan.original_duration_ms)
        elif self._words:
            self._duration_ms = float(self._words[-1].end_ms)
        else:
            self._duration_ms = 0.0
        self.update()

    # -- sizing --------------------------------------------------------------
    def sizeHint(self) -> QSize:
        height = (
            _CAPTION_H + _CAP_BAR_GAP + _BAR_H + _GROUP_GAP
            + _CAPTION_H + _CAP_BAR_GAP + _BAR_H
        )
        return QSize(420, height)

    # -- painting ------------------------------------------------------------
    def paintEvent(self, _event) -> None:
        """Draw both bars (captions + tracks + speech blocks)."""
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)

        width = max(1.0, self.width() - 2 * _PAD_X)
        scale = (width / self._duration_ms) if self._duration_ms > 0 else 0.0

        output_ms = self._output_ms()

        y = 0.0
        self._draw_bar_group(
            painter, y, width, scale,
            label="Original", duration_ms=self._duration_ms,
            is_processed=False,
        )
        y += _CAPTION_H + _CAP_BAR_GAP + _BAR_H + _GROUP_GAP
        self._draw_bar_group(
            painter, y, width, scale,
            label="Processed", duration_ms=output_ms,
            is_processed=True,
        )
        painter.end()

    # -- helpers -------------------------------------------------------------
    def _output_ms(self) -> float:
        """Total kept duration (ms) = sum of the plan's KEEP ranges."""
        if self._plan is None:
            return self._duration_ms
        return sum(b - a for a, b in self._plan.keeps)

    def _draw_bar_group(
        self,
        painter: QPainter,
        top: float,
        width: float,
        scale: float,
        label: str,
        duration_ms: float,
        is_processed: bool,
    ) -> None:
        """Draw one caption line plus its bar."""
        # Caption: label on the left, duration on the right, both muted.
        cap_rect = QRectF(_PAD_X, top, width, _CAPTION_H)
        painter.setPen(QPen(theme.text_muted_color()))
        painter.setFont(theme.font_caption())
        painter.drawText(cap_rect, Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, label)
        painter.drawText(
            cap_rect,
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
            _fmt_ms(duration_ms),
        )

        bar_top = top + _CAPTION_H + _CAP_BAR_GAP
        if is_processed:
            self._draw_processed_bar(painter, bar_top, width, scale)
        else:
            self._draw_original_bar(painter, bar_top, width, scale)

    def _draw_original_bar(
        self, painter: QPainter, top: float, width: float, scale: float
    ) -> None:
        """Full-width silence track with a solid accent block per word."""
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(theme.silence_color())
        painter.drawRoundedRect(QRectF(_PAD_X, top, width, _BAR_H), _BAR_RADIUS, _BAR_RADIUS)

        if scale <= 0:
            return
        painter.setBrush(theme.speech_color())
        for word in self._words:
            x0 = _PAD_X + word.start_ms * scale
            x1 = _PAD_X + word.end_ms * scale
            self._speech_block(painter, x0, x1, top)

    def _draw_processed_bar(
        self, painter: QPainter, top: float, width: float, scale: float
    ) -> None:
        """Ghost the full width, then draw the compacted KEEP ranges on top."""
        painter.setPen(Qt.PenStyle.NoPen)

        # 1) Ghost of the original span -- the part to the right of the kept
        #    region is the removed time.
        painter.setBrush(theme.removed_color())
        painter.drawRoundedRect(QRectF(_PAD_X, top, width, _BAR_H), _BAR_RADIUS, _BAR_RADIUS)

        if self._plan is None or scale <= 0:
            return

        output_end = _PAD_X + self._output_ms() * scale
        kept_w = max(0.0, output_end - _PAD_X)

        # 2) The kept region as one rounded silence track.
        if kept_w > 0:
            painter.setBrush(theme.silence_color())
            painter.drawRoundedRect(QRectF(_PAD_X, top, kept_w, _BAR_H), _BAR_RADIUS, _BAR_RADIUS)

        # 3) Speech blocks, each clipped to its KEEP range and shifted left by
        #    the total gap removed before it (the compaction).
        painter.setBrush(theme.speech_color())
        out_x = _PAD_X
        for a, b in self._plan.keeps:
            seg_w = (b - a) * scale
            for word in self._words:
                ws = max(word.start_ms, a)
                we = min(word.end_ms, b)
                if we > ws:
                    x0 = out_x + (ws - a) * scale
                    x1 = out_x + (we - a) * scale
                    self._speech_block(painter, x0, x1, top)
            out_x += seg_w

        # 4) A subtle dashed seam at the output end so the boundary reads clearly.
        if output_end < _PAD_X + width - 1:
            pen = QPen(theme.border_color())
            pen.setStyle(Qt.PenStyle.DashLine)
            pen.setWidthF(1.0)
            painter.setPen(pen)
            painter.drawLine(int(output_end), int(top), int(output_end), int(top + _BAR_H))
            painter.setPen(Qt.PenStyle.NoPen)

    @staticmethod
    def _speech_block(painter: QPainter, x0: float, x1: float, top: float) -> None:
        """Draw one accent speech block between ``x0`` and ``x1``."""
        w = max(_MIN_BLOCK_W, x1 - x0)
        painter.drawRoundedRect(QRectF(x0, top, w, _BAR_H), _SPEECH_RADIUS, _SPEECH_RADIUS)
