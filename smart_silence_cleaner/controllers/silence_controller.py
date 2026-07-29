"""The one object that turns UI intent into engine calls and back.

:class:`SilenceController` is the *only* place the engine is imported or invoked
(strict MVC). It owns the mutable session state -- the active preset id, the
current :class:`SilenceSettings`, the transcript words and the media duration --
and re-plans on every change, pushing results out through Qt signals the page
binds to.

Signal contract
---------------
``presetChanged(str)``
    The active mode id changed (e.g. a card was selected, or an edit switched the
    mode to *Custom*). Drives which mode card looks selected.
``settingsChanged(object)``
    A new :class:`SilenceSettings` is in effect. Drives the toggles and the
    Advanced spin boxes (both refreshed *silently*).
``slidersChanged(int, int, int)``
    The three creator sliders should jump to ``(pause, speed, breath)``. Emitted
    **only** when a preset is loaded -- never while the user is dragging -- so
    the control the user is touching is never yanked out from under them.
``planChanged(object)``
    A freshly computed :class:`SilencePlan`. Drives the timeline preview, the
    stats grid and the export estimate.
``edlReady(list)``
    Emitted by :meth:`apply` with the plan's EDL rows (``list[dict]``).

Mode-switching rules (per spec)
-------------------------------
* Selecting a card loads that preset's settings and *moves the sliders to match*.
* Moving a slider or editing an Advanced value switches the active mode to
  *Custom* (carrying the current settings -- it does **not** reset them).
* The three toggles (Smart Silence, Keep Sentence Flow, Remove Filler Words) are
  treated as cross-cutting options: they modify the current settings in place and
  do **not** force a switch to Custom. The spec calls out only sliders/Advanced as
  the Custom triggers, so toggles stay layered on top of whatever mode is active.
"""

from __future__ import annotations

from PySide6.QtCore import QObject, Signal

from ..engine.silence_engine import SilenceEngine
from ..models.edl import SilencePlan
from ..models.presets import CUSTOM, Preset, PresetManager
from ..models.settings import (
    SilenceSettings,
    apply_breath_slider,
    apply_pause_slider,
    apply_speed_slider,
    to_sliders,
)
from ..models.word import Word


class SilenceController(QObject):
    """Session state + engine glue for one Smart Silence page."""

    # -- signals (see module docstring for the full contract) ---------------
    presetChanged = Signal(str)
    settingsChanged = Signal(object)
    slidersChanged = Signal(int, int, int)
    planChanged = Signal(object)
    edlReady = Signal(list)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        default = PresetManager.default()
        self._preset_id: str = default.id
        self._settings: SilenceSettings = default.settings.copy()
        self._words: list[Word] = []
        self._duration_ms: float = 0.0
        self._plan: SilencePlan | None = None

    # ------------------------------------------------------------------ #
    # data loading                                                        #
    # ------------------------------------------------------------------ #
    def load(self, words: list[Word], duration_ms: float) -> None:
        """Install the transcript + media duration and pre-compute a plan.

        Does **not** emit -- call :meth:`initialize` once the page is connected so
        the freshly wired widgets receive the opening state.
        """
        self._words = list(words)
        self._duration_ms = float(duration_ms)
        self._plan = SilenceEngine.plan(self._words, self._settings, self._duration_ms)

    def initialize(self) -> None:
        """Emit the opening state to a freshly connected page.

        Loads the current (default) preset, which fans out ``presetChanged``,
        ``settingsChanged``, ``slidersChanged`` and ``planChanged`` in one go.
        """
        self.select_preset(self._preset_id)

    # ------------------------------------------------------------------ #
    # read-only accessors (the view renders from these)                   #
    # ------------------------------------------------------------------ #
    @property
    def words(self) -> list[Word]:
        """The loaded transcript (used to paint the preview)."""
        return self._words

    @property
    def duration_ms(self) -> float:
        """Media length in milliseconds."""
        return self._duration_ms

    @property
    def settings(self) -> SilenceSettings:
        """The settings currently handed to the engine."""
        return self._settings

    @property
    def plan(self) -> SilencePlan | None:
        """The most recently computed plan (``None`` before :meth:`load`)."""
        return self._plan

    @property
    def preset_id(self) -> str:
        """Id of the active mode."""
        return self._preset_id

    @staticmethod
    def presets() -> tuple[Preset, ...]:
        """Every preset, in display order (for building the mode cards)."""
        return PresetManager.all()

    # ------------------------------------------------------------------ #
    # intents from the view                                               #
    # ------------------------------------------------------------------ #
    def select_preset(self, preset_id: str) -> None:
        """Load a preset: adopt its settings and move the sliders to match."""
        preset = PresetManager.get(preset_id)
        self._preset_id = preset.id
        self._settings = preset.settings.copy()

        self.presetChanged.emit(self._preset_id)
        self.settingsChanged.emit(self._settings)
        pause, speed, breath = to_sliders(self._settings)
        self.slidersChanged.emit(pause, speed, breath)
        self._recompute_and_emit()

    def set_pause_slider(self, value: int) -> None:
        """*Keep more pauses ... Remove more pauses* -- edits, enters Custom."""
        self._settings = apply_pause_slider(self._settings, int(value))
        self._enter_custom()
        self.settingsChanged.emit(self._settings)
        self._recompute_and_emit()

    def set_speed_slider(self, value: int) -> None:
        """*Relaxed ... Fast conversation* -- edits, enters Custom."""
        self._settings = apply_speed_slider(self._settings, int(value))
        self._enter_custom()
        self.settingsChanged.emit(self._settings)
        self._recompute_and_emit()

    def set_breath_slider(self, value: int) -> None:
        """*Natural ... Minimal breathing* -- edits, enters Custom."""
        self._settings = apply_breath_slider(self._settings, int(value))
        self._enter_custom()
        self.settingsChanged.emit(self._settings)
        self._recompute_and_emit()

    def set_toggle(self, name: str, on: bool) -> None:
        """Flip one boolean option in place (does not change the active mode).

        ``name`` is a boolean :class:`SilenceSettings` field: ``smart_silence``,
        ``keep_sentence_flow`` or ``remove_fillers``.
        """
        self._settings = self._settings.copy(**{name: bool(on)})
        self.settingsChanged.emit(self._settings)
        self._recompute_and_emit()

    def set_param(self, name: str, value_ms: int) -> None:
        """Set one raw millisecond parameter (Advanced) -- edits, enters Custom.

        ``name`` is a numeric :class:`SilenceSettings` field (e.g. ``min_gap_ms``).
        """
        self._settings = self._settings.copy(**{name: float(value_ms)})
        self._enter_custom()
        self.settingsChanged.emit(self._settings)
        self._recompute_and_emit()

    def apply(self) -> list[dict[str, float | str]]:
        """Finalise: print the EDL rows and emit :pyattr:`edlReady`.

        Returns the rows too, so a caller can use them directly. The rows come
        straight from :meth:`SilencePlan.edl_rows`.
        """
        if self._plan is None:
            self._recompute_and_emit()
        assert self._plan is not None  # guaranteed by the recompute above
        rows = self._plan.edl_rows()

        print(f"\n[Smart Silence] Apply -> {len(rows)} cut(s):")
        for index, row in enumerate(rows, start=1):
            print(f"  {index:>2}. {row}")
        stats = self._plan.stats
        print(
            f"  saved {stats.time_saved_str} ({stats.percent_removed_str}); "
            f"output {stats.fmt_duration(stats.output_duration_ms)}"
        )

        self.edlReady.emit(rows)
        return rows

    # ------------------------------------------------------------------ #
    # internals                                                           #
    # ------------------------------------------------------------------ #
    def _enter_custom(self) -> None:
        """Switch the active mode to Custom (emitting once) if not already."""
        if self._preset_id != CUSTOM.id:
            self._preset_id = CUSTOM.id
            self.presetChanged.emit(self._preset_id)

    def _recompute_and_emit(self) -> None:
        """Re-run the engine for the current settings and emit the new plan."""
        self._plan = SilenceEngine.plan(self._words, self._settings, self._duration_ms)
        self.planChanged.emit(self._plan)
