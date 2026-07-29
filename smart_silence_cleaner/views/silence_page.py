"""The full Smart Silence Cleaner page.

Assembles the reusable widgets into one screen and wires them to a
:class:`~...controllers.silence_controller.SilenceController`. The page is a thin
presentation layer:

* **Out** -- user gestures are forwarded to the controller as intents (a card was
  selected, a slider moved, a toggle flipped, an Advanced value edited, Apply
  pressed).
* **In** -- controller signals are rendered: the selected card, the toggle/Advanced
  state (updated *silently* to avoid feedback), the slider positions (only when a
  preset loads), and the live plan (preview + stats + export estimate).

The page never touches the engine; every number it shows arrives pre-computed
inside the :class:`SilencePlan` the controller pushes.
"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from ..controllers.silence_controller import SilenceController
from ..models.edl import SilencePlan
from ..models.settings import SilenceSettings
from . import theme
from .widgets import (
    AdvancedPanel,
    CreatorSlider,
    ExportPreview,
    ModeCard,
    Section,
    StatsPanel,
    TimelinePreview,
    ToggleRow,
    divider,
)


class SilencePage(QWidget):
    """The composed page, bound to a controller.

    Parameters
    ----------
    controller:
        The already-constructed controller (with its transcript loaded). The page
        connects to it in ``__init__``; the caller then invokes
        :meth:`SilenceController.initialize` to paint the opening state.
    parent:
        Standard Qt parent.
    """

    def __init__(self, controller: SilenceController, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._controller = controller
        self._cards: list[ModeCard] = []

        self._build()
        self._connect()

    # ------------------------------------------------------------------ #
    # construction                                                        #
    # ------------------------------------------------------------------ #
    def _build(self) -> None:
        """Lay out the whole page top to bottom."""
        root = QVBoxLayout(self)
        root.setContentsMargins(28, 24, 28, 28)
        root.setSpacing(18)

        root.addWidget(self._build_header())
        root.addWidget(self._build_modes_section())
        root.addWidget(self._build_preview_section())
        root.addLayout(self._build_controls_row())
        root.addWidget(self._build_advanced_section())
        root.addLayout(self._build_apply_bar())
        root.addStretch(1)

    def _build_header(self) -> QWidget:
        """Page title + one-line subtitle (no card)."""
        header = QWidget()
        box = QVBoxLayout(header)
        box.setContentsMargins(2, 0, 2, 0)
        box.setSpacing(4)

        title = QLabel("Smart Silence Cleaner")
        title.setFont(theme.font(26, QFont.Weight.Bold))
        title.setStyleSheet(f"color: {theme.TEXT};")

        subtitle = QLabel("Remove awkward dead air and keep your video sounding natural.")
        subtitle.setFont(theme.font_subtitle())
        subtitle.setStyleSheet(f"color: {theme.TEXT_MUTED};")

        box.addWidget(title)
        box.addWidget(subtitle)
        return header

    def _build_modes_section(self) -> Section:
        """The five preset cards in one equal-width row."""
        section = Section(
            "Choose your editing style",
            "Pick a starting point. Fine-tune it below or open Advanced for exact control.",
        )
        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(12)

        for preset in self._controller.presets():
            card = ModeCard(preset)
            self._cards.append(card)
            row.addWidget(card, 1)

        section.add_layout(row)
        return section

    def _build_preview_section(self) -> Section:
        """The prominent live before/after timeline, with a reduction chip."""
        section = Section(
            "Live preview",
            "Solid blocks are speech; the faint tail on the processed bar is what gets removed.",
        )

        self._chip = QLabel("--")
        self._chip.setObjectName("Chip")
        self._chip.setFont(theme.font_caption())
        self._chip.setStyleSheet(theme.chip_qss())
        section.set_header_widget(self._chip)

        self._preview = TimelinePreview()
        section.add(self._preview)
        return section

    def _build_controls_row(self) -> QHBoxLayout:
        """Two columns: fine-tune controls (left) and read-outs (right)."""
        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(18)
        row.addWidget(self._build_finetune_section(), 3)

        right = QVBoxLayout()
        right.setContentsMargins(0, 0, 0, 0)
        right.setSpacing(18)
        right.addWidget(self._build_stats_section())
        right.addWidget(self._build_export_section())
        right.addStretch(1)
        row.addLayout(right, 2)
        return row

    def _build_finetune_section(self) -> Section:
        """Three creator sliders, a divider, then three option toggles."""
        section = Section(
            "Fine-tune the pacing",
            "Plain-language controls -- moving any of these switches the mode to Custom.",
        )

        self._pause_slider = CreatorSlider(
            "Pause tightness", "Keep more pauses", "Remove more pauses",
        )
        self._speed_slider = CreatorSlider(
            "Conversation speed", "Relaxed conversation", "Fast conversation",
        )
        self._breath_slider = CreatorSlider(
            "Breathing room", "Natural breathing", "Minimal breathing",
        )
        section.add(self._pause_slider)
        section.add(self._speed_slider)
        section.add(self._breath_slider)

        section.add(divider())

        self._toggle_smart = ToggleRow(
            "Smart Silence",
            "Natural, punctuation-aware pacing. Turn off for simple gap-based trimming.",
            checked=True,
        )
        self._toggle_flow = ToggleRow(
            "Keep Sentence Flow",
            "Leave slightly longer pauses after sentences and commas.",
            checked=True,
        )
        self._toggle_fillers = ToggleRow(
            "Remove Filler Words",
            "Automatically delete ums, uhs and you-knows.",
            checked=False,
        )
        section.add(self._toggle_smart)
        section.add(self._toggle_flow)
        section.add(self._toggle_fillers)
        return section

    def _build_stats_section(self) -> Section:
        """The stat-tile grid."""
        section = Section("Statistics")
        self._stats = StatsPanel()
        section.add(self._stats)
        return section

    def _build_export_section(self) -> Section:
        """The export estimate band."""
        section = Section("Export estimate")
        self._export = ExportPreview()
        section.add(self._export)
        return section

    def _build_advanced_section(self) -> Section:
        """The collapsible raw-parameter panel, wrapped in a card."""
        section = Section()  # headerless card -- the panel carries its own header
        self._advanced = AdvancedPanel()
        section.add(self._advanced)
        return section

    def _build_apply_bar(self) -> QHBoxLayout:
        """Footer: a status hint on the left, the primary Apply button on the right."""
        bar = QHBoxLayout()
        bar.setContentsMargins(2, 0, 2, 0)
        bar.setSpacing(12)

        self._status = QLabel("Ready. Adjust anything above -- the preview updates instantly.")
        self._status.setFont(theme.font_caption())
        self._status.setStyleSheet(f"color: {theme.TEXT_MUTED};")

        self._apply_btn = QPushButton("Apply silence edit")
        self._apply_btn.setFont(theme.font(14, QFont.Weight.DemiBold))
        self._apply_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._apply_btn.setStyleSheet(theme.primary_button_qss())
        self._apply_btn.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)

        bar.addWidget(self._status, 1)
        bar.addStretch(0)
        bar.addWidget(self._apply_btn, 0)
        return bar

    # ------------------------------------------------------------------ #
    # wiring                                                              #
    # ------------------------------------------------------------------ #
    def _connect(self) -> None:
        """Connect view intents outward and controller signals inward."""
        # -- intents out -> controller --
        for card in self._cards:
            card.clicked.connect(self._controller.select_preset)

        self._pause_slider.valueChanged.connect(self._controller.set_pause_slider)
        self._speed_slider.valueChanged.connect(self._controller.set_speed_slider)
        self._breath_slider.valueChanged.connect(self._controller.set_breath_slider)

        self._toggle_smart.toggled.connect(
            lambda on: self._controller.set_toggle("smart_silence", on)
        )
        self._toggle_flow.toggled.connect(
            lambda on: self._controller.set_toggle("keep_sentence_flow", on)
        )
        self._toggle_fillers.toggled.connect(
            lambda on: self._controller.set_toggle("remove_fillers", on)
        )

        self._advanced.paramChanged.connect(self._controller.set_param)
        self._apply_btn.clicked.connect(lambda: self._controller.apply())

        # -- controller signals -> render in --
        self._controller.presetChanged.connect(self._on_preset_changed)
        self._controller.settingsChanged.connect(self._on_settings_changed)
        self._controller.slidersChanged.connect(self._on_sliders_changed)
        self._controller.planChanged.connect(self._on_plan_changed)
        self._controller.edlReady.connect(self._on_edl_ready)

    # ------------------------------------------------------------------ #
    # render slots                                                        #
    # ------------------------------------------------------------------ #
    def _on_preset_changed(self, preset_id: str) -> None:
        """Highlight the card whose id matches the active mode."""
        for card in self._cards:
            card.set_selected(card.preset_id == preset_id)

    def _on_settings_changed(self, settings: SilenceSettings) -> None:
        """Reflect toggles + Advanced spin boxes for new settings (no echo)."""
        self._toggle_smart.set_checked_silently(settings.smart_silence)
        self._toggle_flow.set_checked_silently(settings.keep_sentence_flow)
        self._toggle_fillers.set_checked_silently(settings.remove_fillers)
        self._advanced.set_values_silently(settings)

    def _on_sliders_changed(self, pause: int, speed: int, breath: int) -> None:
        """Move the three sliders to match a freshly loaded preset (no echo)."""
        self._pause_slider.set_value_silently(pause)
        self._speed_slider.set_value_silently(speed)
        self._breath_slider.set_value_silently(breath)

    def _on_plan_changed(self, plan: SilencePlan) -> None:
        """Repaint the preview and refresh every read-out from the new plan."""
        self._preview.set_data(self._controller.words, plan)
        self._stats.set_stats(plan.stats)
        self._export.set_stats(plan.stats)
        self._chip.setText(f"−{plan.stats.percent_removed_str} shorter")

    def _on_edl_ready(self, rows: list) -> None:
        """Acknowledge an Apply -- the full EDL was printed to the console."""
        count = len(rows)
        noun = "cut" if count == 1 else "cuts"
        self._status.setText(
            f"Applied. Prepared {count} {noun} -- the EDL was printed to the console."
        )
