"""PySide6 presentation layer for the Smart Silence Cleaner.

Contains the shared visual language (:mod:`theme`), the composed page
(:class:`~smart_silence_cleaner.views.silence_page.SilencePage`) and the reusable
widgets under :mod:`views.widgets`. Nothing in this package imports or calls the
engine -- views only render what the controller hands them and emit user intent.
"""

from __future__ import annotations

from .silence_page import SilencePage

__all__ = ["SilencePage"]
