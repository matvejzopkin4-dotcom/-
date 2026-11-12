"""HTTP-регрессии /api/play, только stdlib.

ВНИМАНИЕ: КАЖДЫЙ ТЕСТ СБРАСЫВАЕТ СОСТОЯНИЕ СЕРВЕРА через type=new.
Запускать только против отдельного тестового сервера, не живой игры.
Сервер должен быть уже запущен; этот файл не запускает его и не меняет fixtures.
Запуск: python3 tests/test_play_regressions.py
Адрес: P2P_TEST_URL (по умолчанию http://127.0.0.1:8011).
"""

import concurrent.futures
from decimal import Decimal
import json
import math
import os
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen


BASE_URL = os.environ.get("P2P_TEST_URL", "http://127.0.0.1:8011").rstrip("/")


class PlayRegressions(unittest.TestCase):
    def request(self, action=None):
        data = None if action is None else json.dumps(action).encode("utf-8")
        request = Request(BASE_URL + "/api/play", data=data,
                          headers={"Content-Type": "application/json"},
                          method="GET" if action is None else "POST")
        try:
            response = urlopen(request, timeout=15)
        except HTTPError as error:
            response = error
        with response:
            status = response.code
            payload = json.loads(response.read().decode("utf-8"))
        self.assertIsInstance(payload, dict)
        self.assertEqual(set(payload), {"ok", "error", "view"})
        self.assertIs(type(payload["ok"]), bool)
        self.assert_view(payload["view"])
        if status == 200:
            self.assertIs(payload["ok"], True)
            self.assertIsNone(payload["error"])
        else:
            self.assertEqual(status, 400, payload)
            self.assertIs(payload["ok"], False)
            self.assertIsInstance(payload["error"], str)
            self.assertTrue(payload["error"].strip())
        return status, payload

    def number(self, value, nonnegative=False, places=None):
        self.assertIn(type(value), (int, float))
        self.assertTrue(math.isfinite(value))
        if nonnegative:
            self.assertGreaterEqual(value, 0)
        if places is not None:
            decimal = Decimal(str(value))
            self.assertEqual(decimal, decimal.quantize(Decimal(1).scaleb(-places)))

    def strings(self, value, keys):
        for key in keys:
            self.assertIsInstance(value[key], str, key)

    def assert_view(self, view):
        self.assertIsInstance(view, dict)
        self.assertEqual(set(view), {
            "day", "chapter", "rub", "usdt", "energy", "pnlNet",
            "market", "items", "story", "messages", "log",
        })
        for key in ("day", "chapter"):
            self.assertIs(type(view[key]), int)
            self.assertGreaterEqual(view[key], 1)
        self.number(view["rub"], nonnegative=True, places=2)
        self.number(view["usdt"], nonnegative=True, places=6)
        self.number(view["energy"], nonnegative=True)
        self.number(view["pnlNet"], places=2)
        market = view["market"]
        self.assertIsInstance(market, dict)
        self.assertEqual(set(market), {"buyRate", "sellRate"})
        for value in market.values():
            self.number(value)
            self.assertGreater(value, 0)
        self.assertIsInstance(view["items"], list)
        for item in view["items"]:
            self.assertEqual(set(item), {"id", "title", "price", "owned"})
            self.strings(item, ("id", "title"))
            self.number(item["price"], nonnegative=True, places=2)
            self.assertIs(type(item["owned"]), bool)
        story = view["story"]
        self.assertIsInstance(story, dict)
        self.assertEqual(set(story), {
            "sceneId", "title", "text", "objective", "progress", "target",
            "choices", "completed",
        })
        self.strings(story, ("sceneId", "title", "text", "objective"))
        for key in ("progress", "target"):
            self.number(story[key])
        self.assertIs(type(story["completed"]), bool)
        self.assertIsInstance(story["choices"], list)
        for choice in story["choices"]:
            self.assertEqual(set(choice), {"id", "label"})
            self.strings(choice, ("id", "label"))
        for key, fields in (("messages", {"id", "author", "text"}),
                            ("log", {"id", "text", "kind"})):
            self.assertIsInstance(view[key], list)
            for entry in view[key]:
                self.assertEqual(set(entry), fields)
                self.strings(entry, fields)
                if key == "log":
                    self.assertIn(entry["kind"], ("info", "success", "error"))

    def action(self, action):
        status, payload = self.request(action)
        self.assertEqual(status, 200, payload)
        return payload["view"]

    def read(self):
        status, payload = self.request()
        self.assertEqual(status, 200, payload)
        return payload["view"]

    def rejected(self, action, before):
        status, payload = self.request(action)
        self.assertEqual(status, 400, payload)
        # Включая сюжет, сообщения и журнал: отказ не меняет VIEW вообще.
        self.assertEqual(payload["view"], before)
        self.assertEqual(self.read(), before)

    def setUp(self):
        self.initial = self.action({"type": "new"})

    def test_exact_view_and_initial_state(self):
        view = self.initial
        self.assertEqual(self.read(), view)
        self.assertEqual((view["day"], view["chapter"]), (1, 1))
        self.assertEqual((view["rub"], view["usdt"], view["energy"]),
                         (3700, 0, 100))
        self.assertEqual(view["pnlNet"], 0)
        self.assertEqual(view["market"], {"buyRate": 91, "sellRate": 92})
        self.assertFalse(view["story"]["completed"])

    def test_round_trip_30_usdt(self):
        bought = self.action({"type": "buy", "amount": 30})
        self.assertEqual((bought["rub"], bought["usdt"], bought["energy"]),
                         (970, 30, 95))
        sold = self.action({"type": "sell", "amount": 30})
        self.assertEqual((sold["rub"], sold["usdt"], sold["energy"]),
                         (3730, 0, 90))
        self.assertEqual(sold["pnlNet"], 30)
        self.assertEqual(self.read(), sold)

    def test_insufficient_balances_are_unchanged(self):
        self.rejected({"type": "buy", "amount": 41}, self.initial)
        self.rejected({"type": "sell", "amount": 1}, self.initial)
        bought = self.action({"type": "buy", "amount": 30})
        self.rejected({"type": "buy", "amount": 11}, bought)
        self.rejected({"type": "sell", "amount": 31}, bought)

    def test_property_is_charged_exactly_once(self):
        affordable = [item for item in self.initial["items"]
                      if not item["owned"] and 0 < item["price"] <= self.initial["rub"]]
        self.assertTrue(affordable, "Нужен хотя бы один доступный платный предмет")
        item = min(affordable, key=lambda candidate: candidate["price"])
        bought = self.action({"type": "purchase", "itemId": item["id"]})
        self.assertEqual(Decimal(str(bought["rub"])),
                         Decimal("3700") - Decimal(str(item["price"])))
        expected_items = [dict(entry, owned=True) if entry["id"] == item["id"]
                          else entry for entry in self.initial["items"]]
        self.assertEqual(bought["items"], expected_items)
        self.assertEqual(bought["usdt"], self.initial["usdt"])
        self.rejected({"type": "purchase", "itemId": item["id"]}, bought)

    def test_energy_exhaustion_and_next_day_without_money(self):
        view = self.initial
        for index in range(20):
            view = self.action({"type": "buy" if index % 2 == 0 else "sell",
                                "amount": 1})
            self.assertEqual(view["energy"], 100 - 5 * (index + 1))
        self.assertEqual((view["rub"], view["usdt"]), (3710, 0))
        self.rejected({"type": "buy", "amount": 1}, view)
        rested = self.action({"type": "advance_day"})
        self.assertEqual(rested["day"], view["day"] + 1)
        self.assertEqual(rested["energy"], 100)
        for key in ("rub", "usdt", "pnlNet", "items"):
            self.assertEqual(rested[key], view[key], key)
        traded = self.action({"type": "buy", "amount": 1})
        expected_rub = (Decimal(str(rested["rub"]))
                        - Decimal(str(rested["market"]["buyRate"])))
        self.assertEqual(Decimal(str(traded["rub"])), expected_rub)
        self.assertEqual((traded["usdt"], traded["energy"]), (1, 95))

    def test_concurrent_purchases_cannot_exceed_3700_rub(self):
        # Оба запроса по отдельности допустимы, вместе требуют 5460 RUB.
        barrier = threading.Barrier(2)

        def buy():
            barrier.wait(timeout=10)
            return self.request({"type": "buy", "amount": 30})

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(buy) for _ in range(2)]
            results = [future.result(timeout=30) for future in futures]
        self.assertEqual(sorted(status for status, _ in results), [200, 400])
        view = self.read()
        self.assertEqual((view["rub"], view["usdt"], view["energy"]), (970, 30, 95))
        self.assertEqual(view["pnlNet"], 0)
        self.assertEqual(view["rub"] + view["usdt"] * 91, 3700)
        for _, payload in results:
            self.assertEqual(payload["view"], view)

    def test_story_requires_introduction_trade_and_final_choice(self):
        start = self.initial
        self.assertTrue(start["story"]["choices"], "Нет ответа для знакомства")
        intro_id = start["story"]["choices"][0]["id"]
        introduced = self.action({"type": "choice", "choiceId": intro_id})
        self.assertFalse(introduced["story"]["completed"])
        self.assertNotEqual(introduced["story"]["sceneId"], start["story"]["sceneId"])
        self.assertNotEqual(introduced["story"]["objective"], start["story"]["objective"])
        self.assertNotEqual(introduced["messages"], start["messages"])
        for _ in range(3):
            self.rejected({"type": "choice", "choiceId": intro_id}, introduced)
        # Если сервер показывает ответы раньше сделки, они не могут продвинуть её.
        for choice in introduced["story"]["choices"]:
            self.rejected({"type": "choice", "choiceId": choice["id"]}, introduced)
        self.rejected({"type": "sell", "amount": 30}, introduced)
        bought = self.action({"type": "buy", "amount": 30})
        self.assertFalse(bought["story"]["completed"])
        for choice in bought["story"]["choices"]:
            self.rejected({"type": "choice", "choiceId": choice["id"]}, bought)
        sold = self.action({"type": "sell", "amount": 30})
        self.assertFalse(sold["story"]["completed"], "Продажа не заменяет итоговый ответ")
        self.assertNotEqual(sold["story"]["sceneId"], introduced["story"]["sceneId"])
        self.assertNotEqual(sold["story"]["objective"], introduced["story"]["objective"])
        self.assertTrue(sold["story"]["choices"], "После сделки нет итогового ответа")
        self.rejected({"type": "choice", "choiceId": intro_id}, sold)
        final_id = sold["story"]["choices"][0]["id"]
        self.assertNotEqual(final_id, intro_id)
        finished = self.action({"type": "choice", "choiceId": final_id})
        self.assertTrue(finished["story"]["completed"])
        self.assertNotEqual(finished["messages"], sold["messages"])
        self.assertGreaterEqual(finished["story"]["progress"], finished["story"]["target"])
        self.rejected({"type": "choice", "choiceId": final_id}, finished)
        self.rejected({"type": "choice", "choiceId": intro_id}, finished)


if __name__ == "__main__":
    print("ВНИМАНИЕ: тесты сбрасывают состояние сервера " + BASE_URL, flush=True)
    unittest.main(verbosity=2)
