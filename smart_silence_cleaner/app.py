"""Stand-alone entry point for the Smart Silence Cleaner page.

Run it directly to see the page with the bundled demo transcript::

    python -m smart_silence_cleaner.app

It builds a :class:`QApplication`, applies the theme, constructs a
:class:`~smart_silence_cleaner.controllers.silence_controller.SilenceController`
loaded with :func:`~smart_silence_cleaner.sample_data.sample_words`, drops the
:class:`~smart_silence_cleaner.views.silence_page.SilencePage` into a scrollable
:class:`QMainWindow`, and finally calls
:meth:`SilenceController.initialize` so the freshly connected widgets paint the
opening state. No real media or network is required.
"""

from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication, QMainWindow, QScrollArea

from .controllers.silence_controller import SilenceController
from .sample_data import SAMPLE_DURATION_MS, sample_words
from .views.silence_page import SilencePage
from .views.theme import apply_theme


def main() -> int:
    """Build the window, show it, and run the Qt event loop.

    Returns the process exit code from :meth:`QApplication.exec`.
    """
    app = QApplication.instance() or QApplication(sys.argv)
    apply_theme(app)

    # The controller owns the session state; load the demo transcript into it
    # *before* the page connects so the opening plan is ready to paint.
    controller = SilenceController()
    controller.load(sample_words(), SAMPLE_DURATION_MS)

    page = SilencePage(controller)

    # A scroll area keeps the tall page usable on shorter screens.
    scroll = QScrollArea()
    scroll.setWidgetResizable(True)
    scroll.setWidget(page)

    window = QMainWindow()
    window.setWindowTitle("Smart Silence Cleaner")
    window.setCentralWidget(scroll)
    window.resize(1280, 920)
    window.setMinimumSize(1040, 680)
    window.show()

    # Now that the page is wired to the controller, emit the opening state.
    controller.initialize()

    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
