# -*- coding: utf-8 -*-
"""REST-сервер «P2P: С НУЛЯ» — только stdlib, порт 8000.

Запуск: python src/backend/app.py
Роуты: POST /api/new, GET /api/state, POST /api/action, GET /api/content.
Статика фронтенда раздаётся из src/frontend/ с CORS-заголовками.
"""
import json
import os
import copy
import threading
from urllib.parse import unquote, urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if __package__:
    from . import engine
else:
    import engine

PORT = int(os.environ.get("P2P_PORT") or 8000)  # 8000 по контракту; на машинах, где порт занят, задаётся P2P_PORT
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")

STATE = None  # текущее состояние игры (в памяти процесса)
STATE_LOCK = threading.RLock()


def handle_request(method, path, data=None):
    """Общий обработчик API, вызывается также тестами без HTTP-сервера."""
    global STATE
    path = urlsplit(path).path
    with STATE_LOCK:
        if path == "/api/play" and method in ("GET", "POST"):
            state = _get_state()
            error = None
            if method == "POST":
                if isinstance(data, dict) and data == {"type": "new"}:
                    STATE = state = engine.new_state()
                else:
                    error = engine.play_action(state, data)
            return {"ok": error is None, "error": error, "view": engine.play_view(state)}
        if method == "POST" and path == "/api/new":
            if data is not None and not isinstance(data, dict):
                return {"ok": False, "error": "Ожидается JSON-объект"}
            STATE = engine.new_state()
            return {"ok": True, "state": copy.deepcopy(STATE)}
        if method == "GET" and path == "/api/state":
            return {"ok": True, "state": copy.deepcopy(_get_state())}
        if method == "GET" and path == "/api/content":
            return {"ok": True, "content": copy.deepcopy(engine.DATA)}
        if method == "POST" and path == "/api/action":
            state = _get_state()
            error = engine.do_action(state, data)
            if error:
                return {"ok": False, "error": error}
            return {"ok": True, "state": copy.deepcopy(state)}
        return {"ok": False, "error": "Неизвестный маршрут или метод"}

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def _get_state():
    """Текущее состояние; при первом обращении игра создаётся автоматически."""
    global STATE
    if STATE is None:
        STATE = engine.new_state()
    return STATE


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # --- служебное -------------------------------------------------------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length < 0 or length > 65536:
                self.close_connection = True
                return None
            if not length:
                return {}
            return json.loads(self.rfile.read(length).decode("utf-8"),
                              parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        except (ValueError, UnicodeDecodeError):
            self.close_connection = True
            return None

    def log_message(self, fmt, *args):  # тише в консоли
        pass

    # --- роуты -----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/api/state", "/api/content", "/api/play"):
            self._send_json(handle_request("GET", path))
        elif path.startswith("/api/"):
            self._send_json({"ok": False, "error": "Неизвестный роут: %s" % path}, 404)
        else:
            self._serve_static(path)

    def _drain_body(self):
        """Считать и отбросить тело запроса, иначе на keep-alive оно разберётся как следующий запрос."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.close_connection = True
            return
        if 0 < length <= 65536:
            self.rfile.read(length)
        else:
            self.close_connection = True

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path in ("/api/new", "/api/action", "/api/play"):
            data = self._read_json()
            if data is None:
                if path == "/api/play":
                    with STATE_LOCK:
                        response = {"ok": False, "error": "Некорректный JSON",
                                    "view": engine.play_view(_get_state())}
                    self._send_json(response, 400)
                else:
                    self._send_json({"ok": False, "error": "Некорректный JSON"})
                return
            response = handle_request("POST", path, data)
            self._send_json(response, 400 if path == "/api/play" and not response["ok"] else 200)
        elif path == "/api/state":
            self._drain_body()
            self._send_json({"ok": False, "error": "Используйте GET для /api/state"})
        elif path.startswith("/api/"):
            self._drain_body()
            self._send_json({"ok": False, "error": "Неизвестный роут: %s" % path}, 404)
        else:
            self._drain_body()
            self._send_json({"ok": False, "error": "Неизвестный роут: %s" % path}, 404)

    # --- статика ---------------------------------------------------------
    def _serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = os.path.normpath(unquote(path).lstrip("/"))
        if "\x00" in rel:
            self._send_json({"ok": False, "error": "Недопустимый путь"}, 400)
            return
        root = os.path.realpath(FRONTEND_DIR)
        full = os.path.realpath(os.path.join(root, rel))
        if os.path.commonpath((root, full)) != root:
            self._send_json({"ok": False, "error": "Доступ запрещён"}, 403)
            return
        if not os.path.isfile(full):
            self._send_json({"ok": False, "error": "Файл не найден"}, 404)
            return
        with open(full, "rb") as f:
            body = f.read()
        ext = os.path.splitext(full)[1].lower()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("P2P: С НУЛЯ — сервер на http://localhost:%d" % PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    import sys
    if "--self-test" in sys.argv:
        initial = handle_request("POST", "/api/new", {})
        assert initial["ok"] and initial["state"]["rub"] == 3700
        assert handle_request("GET", "/api/state") == initial
        assert handle_request("GET", "/api/content")["ok"]
        assert not handle_request("POST", "/api/action", {"type": "unknown"})["ok"]
        assert handle_request("GET", "/api/state") == initial
        assert handle_request("POST", "/api/action", {"type": "advance_day"})["state"]["day"] == 2
        print("PASS: прямые обработчики new/state/content/action без запуска HTTP")
    else:
        main()
