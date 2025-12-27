from __future__ import annotations

import json
import logging
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    import webview

logger = logging.getLogger(__name__)


class WebViewController:
    """Controller for dispatching events to the webview frontend."""

    _window: webview.Window | None = None

    @classmethod
    def dispatch_event(cls, action: str, payload: Any = None) -> None:
        """Dispatch an event to the frontend JavaScript.
        
        Args:
            action: The action/event name to dispatch.
            payload: Optional payload data to send with the event.
        """
        if not action:
            return

        try:
            action_js = json.dumps(action)
            payload_js = "undefined" if payload is None else json.dumps(payload)
            script = f"window.pythonEvent && window.pythonEvent({action_js}, {payload_js});"

            if cls._window is not None:
                cls._window.evaluate_js(script)
        except (TypeError, ValueError) as e:
            logger.error("Failed to serialize event payload: %s", e)
        except Exception as e:
            logger.exception("Failed to dispatch event '%s': %s", action, e)

    @classmethod
    def set_window(cls, window: webview.Window) -> None:
        """Set the webview window instance.
        
        Args:
            window: The pywebview Window instance.
        """
        cls._window = window