# -*- coding: utf-8 -*-
"""Интеграционная проверка по настоящему HTTP (сервер уже запущен).

Вспомогательный скрипт ведущего, не часть продукта: запускается при уже
работающем сервере, например  P2P_PORT=8010 python3 src/backend/app.py
"""
import json
import sys
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8010"


def call(method, path, data=None):
    req = urllib.request.Request(BASE + path, method=method)
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, body, timeout=5) as r:
            return r.status, r.read().decode("utf-8"), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8"), e.headers


def j(text):
    try:
        return json.loads(text)
    except ValueError:
        return None


fails = []


def check(name, cond, detail=""):
    print(("OK   " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))
    if not cond:
        fails.append(name)


# 1. статика
for path, marker in (("/", "P2P"), ("/app.js", "API"), ("/style.css", "--bg")):
    code, text, _ = call("GET", path)
    check("статика %s" % path, code == 200 and marker in text, "HTTP %d" % code)

# 2. /api/new
code, text, _ = call("POST", "/api/new", {})
r = j(text) or {}
s = r.get("state", {})
check("/api/new", code == 200 and r.get("ok") is True and s.get("rub") == 3700
      and s.get("chapter") == 1 and s.get("energy") == 100,
      "rub=%s chapter=%s energy=%s" % (s.get("rub"), s.get("chapter"), s.get("energy")))

# 3. /api/state
code, text, _ = call("GET", "/api/state")
r2 = j(text) or {}
check("/api/state", code == 200 and r2.get("ok") and r2.get("state") == s)

# 4. /api/content
code, text, _ = call("GET", "/api/content")
c = (j(text) or {}).get("content", {})
counts = [len(c.get(k, [])) for k in ("characters", "chapters", "exchanges", "banks", "properties")]
check("/api/content", code == 200 and (j(text) or {}).get("ok") and counts == [9, 8, 6, 6, 4], counts)

# 5. сделка сверх баланса -> ok:false, state не меняется
before = json.dumps(s, sort_keys=True)
code, text, _ = call("POST", "/api/action", {"type": "deal", "payload": {
    "side": "buy", "amountUsdt": 1000, "priceRub": 91.0,
    "exchange": "bybit", "bank": "tbank"}})
r4 = j(text) or {}
code, text, _ = call("GET", "/api/state")
r5 = j(text) or {}
check("недостаточно средств", r4.get("ok") is False and isinstance(r4.get("error"), str)
      and json.dumps(r5.get("state"), sort_keys=True) == before, r4.get("error"))

# 6. реальный цикл по HTTP: buy 30 USDT @91 -> sell @92 => +30 RUB
code, text, _ = call("POST", "/api/action", {"type": "deal", "payload": {
    "side": "buy", "amountUsdt": 30, "priceRub": 91.0,
    "exchange": "bybit", "bank": "tbank"}})
code, text, _ = call("POST", "/api/action", {"type": "deal", "payload": {
    "side": "sell", "amountUsdt": 30, "priceRub": 92.0,
    "exchange": "bybit", "bank": "tbank"}})
rs = j(text) or {}
st = rs.get("state", {})
last = st.get("deals", [{}])[-1] if st.get("deals") else {}
check("цикл buy/sell по HTTP", rs.get("ok") and abs(st.get("rub", 0) - 3730.0) < 1e-6
      and st.get("usdt") == 0 and last.get("pnlNet") == 30.0,
      "rub=%s pnlNet=%s" % (st.get("rub"), last.get("pnlNet")))

# 7. chat_reply меняет trust
code, text, _ = call("POST", "/api/action", {"type": "chat_reply", "payload": {
    "chatId": "chat_local", "optionId": "opt_thanks"}})
rc = j(text) or {}
check("chat_reply", rc.get("ok") and rc.get("state", {}).get("trust", {}).get("danya") == 80,
      "danya=%s" % rc.get("state", {}).get("trust", {}).get("danya"))

# 8. advance_day
code, text, _ = call("POST", "/api/action", {"type": "advance_day", "payload": {}})
rd = j(text) or {}
check("advance_day", rd.get("ok") and rd.get("state", {}).get("day") == 2,
      "day=%s" % rd.get("state", {}).get("day"))

# 9. неверный type
code, text, _ = call("POST", "/api/action", {"type": "nope", "payload": {}})
ri = j(text) or {}
check("неверный type", ri.get("ok") is False and isinstance(ri.get("error"), str)
      and "state" not in ri, ri.get("error"))

# 10. CORS-заголовок
code, text, headers = call("GET", "/api/state")
check("CORS", headers.get("Access-Control-Allow-Origin") == "*",
      headers.get("Access-Control-Allow-Origin"))

print("ИТОГО: упало %d" % len(fails))
sys.exit(1 if fails else 0)
