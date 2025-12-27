from pathlib import Path
import sys
import webview
import os
from util.webview_controller import WebViewController

if getattr(sys, "frozen", False):  # running as PyInstaller exe
    ENV = "prod"
else:
    ENV = os.getenv("ENV", "dev")

class Api:
    def __init__(self):
        pass

def resource_path(*relative_parts):
	base = Path(getattr(sys, '_MEIPASS', Path(__file__).parent))
	return base.joinpath(*relative_parts)

if __name__ == "__main__":
    api = Api()
    url = "http://localhost:5173" if ENV == "dev" else str(resource_path("ui", "index.html"))
    window = webview.create_window("YTMusic", url, js_api=api, resizable=True, width=1280, height=720)
    WebViewController.set_window(window)
    webview.start()

