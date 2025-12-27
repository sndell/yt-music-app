import json

class WebViewController:
    _window = None

    @classmethod
    def dispatch_event(cls, action, payload=None):
        if not action:
            return
      
        action_js = json.dumps(action)
        payload_js = "undefined" if payload is None else json.dumps(payload)
        script = f"window.pythonEvent && window.pythonEvent({action_js}, {payload_js});"
        if cls._window is not None:
            cls._window.evaluate_js(script)

    @classmethod
    def set_window(cls, window):
        cls._window = window