# -*- coding: utf-8 -*-
"""Шесть сценариев API без HTTP, сервера и сторонних пакетов.

Запуск: python tests/test_api_contract.py (или python3).
Каждый сценарий независим: первое исключение фиксируется, следующий продолжается.
Дополнительные служебные ключи state разрешены; обязательные проверяются строго.
"""
import copy
import importlib
import math
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "..", "src", "backend"))
RESULTS = []


def require(condition, key, actual, expected):
    if not condition:
        raise AssertionError("%s=%r; ожидалось %s" % (key, actual, expected))


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def state_contract(s):
    require(isinstance(s, dict), "state", s, "объект")
    required = {"day", "chapter", "rub", "usdt", "energy", "stress", "focus",
                "trust", "log", "chats", "deals", "ownedProperties"}
    missing = sorted(required - s.keys())
    require(not missing, "state: отсутствующие ключи", missing, "[]")
    for key in ("day", "chapter"):
        require(type(s[key]) is int and s[key] >= 1, "state." + key, s[key], "целое >=1")
    for key in ("rub", "usdt", "energy", "stress", "focus"):
        require(numeric(s[key]), "state." + key, s[key], "конечное число")
    for key in ("energy", "stress", "focus"):
        require(0 <= s[key] <= 100, "state." + key, s[key], "0..100")
    require(isinstance(s["trust"], dict), "state.trust", s["trust"], "объект")
    for cid, value in s["trust"].items():
        require(numeric(value) and 0 <= value <= 100, "state.trust." + cid, value, "0..100")
    for key in ("log", "deals", "ownedProperties"):
        require(isinstance(s[key], list), "state." + key, s[key], "список")
    for i, item in enumerate(s["log"]):
        require(isinstance(item, dict) and type(item.get("day")) is int
                and isinstance(item.get("text"), str), "state.log[%d]" % i, item, "{day:int,text:str}")
    for i, item in enumerate(s["deals"]):
        require(isinstance(item, dict) and type(item.get("day")) is int
                and item.get("side") in ("buy", "sell")
                and all(numeric(item.get(k)) for k in ("amountUsdt", "priceRub", "pnlNet")),
                "state.deals[%d]" % i, item, "{day,side,amountUsdt,priceRub,pnlNet}")
    require(all(isinstance(p, str) for p in s["ownedProperties"]),
            "state.ownedProperties", s["ownedProperties"], "список строк")
    require(isinstance(s["chats"], dict), "state.chats", s["chats"], "объект")
    for cid, chat in s["chats"].items():
        prefix = "state.chats." + cid
        require(isinstance(chat, dict) and isinstance(chat.get("title"), str)
                and isinstance(chat.get("messages"), list), prefix, chat, "{title:str,messages:list}")
        for msg in chat["messages"]:
            require(isinstance(msg, dict) and isinstance(msg.get("from"), str)
                    and isinstance(msg.get("text"), str) and isinstance(msg.get("options"), list),
                    prefix + ".messages", msg, "{from:str,text:str,options:list}")
            for opt in msg["options"]:
                require(isinstance(opt, dict) and isinstance(opt.get("id"), str)
                        and isinstance(opt.get("text"), str), prefix + ".options", opt, "{id:str,text:str}")


def success(response):
    require(isinstance(response, dict), "response", response, "объект")
    require(response.get("ok") is True, "response.ok", response.get("ok"), "true; response=%r" % response)
    require("state" in response and "error" not in response, "response.keys", sorted(response), "ok,state без error")
    state_contract(response["state"])
    return response["state"]


def fresh():
    app = importlib.import_module("app")
    return app, success(app.handle_request("POST", "/api/new", {}))


def c_new():
    _, state = fresh()
    for key, value in (("rub", 3700), ("chapter", 1), ("energy", 100)):
        require(state[key] == value, "state." + key, state[key], repr(value))
    return "ok:true, rub=3700.0, chapter=1, energy=100.0"


def c_state():
    app, initial = fresh()
    actual = success(app.handle_request("GET", "/api/state"))
    require(actual == initial, "state", actual, repr(initial))
    return "ok:true, state совпадает с /api/new"


def c_deal():
    app, _ = fresh()
    # 3700 RUB не хватает для эталона 91000 RUB: только локальная фикстура,
    # не новый API и не изменение продуктового стартового баланса.
    app.STATE["rub"] = 100000.0
    content = app.handle_request("GET", "/api/content")["content"]
    exchange = next(x["id"] for x in content["exchanges"] if x["feeMaker"] == 0)
    bank = next(b["id"] for b in content["banks"] if b["sbpFreeLimit"] >= 91000)
    for side, price in (("buy", 91.0), ("sell", 92.0)):
        state = success(app.handle_request("POST", "/api/action", {"type": "deal", "payload": {
            "side": side, "amountUsdt": 1000.0, "priceRub": price, "exchange": exchange, "bank": bank}}))
    for key, expected in (("rub", 101000.0), ("usdt", 0.0)):
        require(abs(state[key] - expected) < 1e-6, "state." + key, state[key], repr(expected))
    require(len(state["deals"]) == 2, "state.deals.length", len(state["deals"]), "2")
    require(state["deals"][-1]["pnlNet"] == 1000.0, "state.deals[-1].pnlNet", state["deals"][-1]["pnlNet"], "1000.0")
    return "ok:true, rub=101000.0, usdt=0.0, deals[-1].pnlNet=1000.0 (фикстура rub=100000)"


def c_chat():
    app, before = fresh()
    for cid, chat in before["chats"].items():
        for msg in chat["messages"]:
            for option in msg["options"]:
                after = success(app.handle_request("POST", "/api/action", {"type": "chat_reply", "payload": {
                    "chatId": cid, "optionId": option["id"]}}))
                require(after["trust"] != before["trust"], "state.trust", after["trust"], "изменение после ответа")
                return "ok:true, chatId=%s, optionId=%s, trust изменилось" % (cid, option["id"])
    raise AssertionError("state.chats: нет доступного options[0]")


def c_day():
    app, before = fresh()
    after = success(app.handle_request("POST", "/api/action", {"type": "advance_day", "payload": {}}))
    require(after["day"] == before["day"] + 1, "state.day", after["day"], repr(before["day"] + 1))
    return "ok:true, day=2"


def c_invalid():
    app, before = fresh()
    before = copy.deepcopy(before)
    response = app.handle_request("POST", "/api/action", {"type": "invalid_type", "payload": {}})
    require(isinstance(response, dict), "response", response, "объект")
    require(response.get("ok") is False, "response.ok", response.get("ok"), "false")
    require(isinstance(response.get("error"), str) and bool(response["error"]), "response.error", response.get("error"), "непустая строка")
    require("state" not in response, "response.keys", sorted(response), "ok,error без state")
    after = success(app.handle_request("GET", "/api/state"))
    require(after == before, "state после ошибки", after, repr(before))
    return "ok:false, error=%r; state не изменилось" % response["error"]


def main():
    for name, fn in (("1. /api/new", c_new), ("2. /api/state", c_state),
                     ("3. /api/action deal buy/sell", c_deal),
                     ("4. /api/action chat_reply", c_chat),
                     ("5. /api/action advance_day", c_day),
                     ("6. /api/action неверный type", c_invalid)):
        try:
            detail = fn()
            ok = True
        except Exception as exc:
            ok, detail = False, "%s: %s" % (type(exc).__name__, exc)
        RESULTS.append(ok)
        print(("OK   " if ok else "FAIL ") + name + " — " + detail)
    passed = sum(RESULTS)
    print("ИТОГО: пройдено %d, упало %d (из %d)" % (passed, len(RESULTS) - passed, len(RESULTS)))
    return 0 if all(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
