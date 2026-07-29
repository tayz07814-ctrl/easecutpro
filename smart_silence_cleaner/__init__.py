"""Smart Silence Cleaner — a transcript-driven silence editor for PySide6.

This package removes *unnecessary dead air* from spoken video using only the
word-level timestamps produced by AssemblyAI. It never analyses the audio
waveform (no amplitude / DSP): every decision is made from ``word.start`` and
``word.end``.

Architecture (strict MVC — the engine never imports Qt):

    config.py            constants, tunables, filler-word list, punctuation sets
    models/              plain data: Word, SilenceSettings, presets, EDL/plan
    engine/              pure logic: SilenceEngine (words+settings -> cut plan) + stats
    views/               PySide6 widgets (the page + reusable cards/sliders/preview)
    controllers/         glue: turns UI settings into engine calls and back
    sample_data.py       a demo transcript so the page runs stand-alone
    app.py               stand-alone entry point (QApplication + window)

The golden rule: **the silence engine knows nothing about the UI**. The UI only
sends a :class:`~smart_silence_cleaner.models.settings.SilenceSettings` and
receives a :class:`~smart_silence_cleaner.models.edl.SilencePlan` (cut list +
stats). That keeps the engine unit-testable with no display attached.
"""

__all__ = ["__version__"]

__version__ = "1.0.0"
