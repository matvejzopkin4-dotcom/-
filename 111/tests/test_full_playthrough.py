# -*- coding: utf-8 -*-
"""Полное сценарное тестирование «P2P: С НУЛЯ» от Главы 1 до Главы 8 и всех 4 финалов.

Запуск: python tests/test_full_playthrough.py
"""
import copy
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(HERE, "..", "src", "backend")
sys.path.insert(0, BACKEND)
sys.dont_write_bytecode = True

import engine


def run_full_scenario_test():
    print("=== ТЕСТ 1: Стартовое состояние Главы 1 ===")
    state = engine.new_state()
    assert state["chapter"] == 1
    assert state["rub"] == 3700.0
    assert state["city"] == "NOVOZAROVSK"
    assert state["energy"] == 100.0
    print("✓ Старт: 3700 ₽, Новозаровск, 100 энергии.")

    print("\n=== ТЕСТ 2: Подработки в Главе 1 ===")
    # Выполняем подработки: разгрузка с Даней и продажа карты на Авито
    assert engine.do_action(state, {"type": "hustle", "payload": {"hustleId": "loader"}}) is None
    assert state["rub"] == 5500.0
    assert state["energy"] == 75.0
    
    assert engine.do_action(state, {"type": "hustle", "payload": {"hustleId": "avito"}}) is None
    assert state["rub"] == 8700.0
    
    assert engine.do_action(state, {"type": "hustle", "payload": {"hustleId": "carwash"}}) is None
    assert state["rub"] == 10200.0
    # Превышен порог 10 000 RUB -> переход в Главу 2!
    assert state["chapter"] == 2
    print("✓ Подработки выполнены: капитал 10 200 ₽ -> Переход в Главу 2: «Первый USDT»!")

    print("\n=== ТЕСТ 3: Торговля в стакане и спред ===")
    # Покупка 100 USDT по 91.0
    buy_deal = {
        "type": "deal",
        "payload": {"side": "buy", "amountUsdt": 100.0, "priceRub": 91.0, "exchange": "bybit", "bank": "tbank"}
    }
    assert engine.do_action(state, buy_deal) is None
    assert state["usdt"] == 100.0
    
    # Продажа 100 USDT по 92.0 -> чистая прибыль +100 руб
    sell_deal = {
        "type": "deal",
        "payload": {"side": "sell", "amountUsdt": 100.0, "priceRub": 92.0, "exchange": "bybit", "bank": "tbank"}
    }
    assert engine.do_action(state, sell_deal) is None
    assert state["usdt"] == 0.0
    assert state["deals"][-1]["pnlNet"] == 100.0
    print("✓ Торговый цикл Bybit/Т-Банк успешно закрыт. PnL: +100 ₽")

    print("\n=== ТЕСТ 4: Инспектор ордеров (115-ФЗ / 161-ФЗ) ===")
    # Проверяем активный ордер
    order = state["activeOrder"]
    if order["isCounterpartyMatch"] and order["isReceiptAuthentic"]:
        assert engine.do_action(state, {"type": "inspect_order", "payload": {"decision": "confirm"}}) is None
        print("✓ Чистый ордер подтверждён, средства зачислены.")
    else:
        assert engine.do_action(state, {"type": "inspect_order", "payload": {"decision": "appeal"}}) is None
        print("✓ Попытка мошенничества/треугольника успешно пресечена апелляцией!")

    print("\n=== ТЕСТ 5: Верификация гаранта на OTC-доске ===")
    # Проверка выявления фейкового гаранта
    fake_offer_id = next(o["id"] for o in state["otcOffers"] if not o["isGuarantorLegit"])
    assert engine.do_action(state, {"type": "verify_guarantor", "payload": {"offerId": fake_offer_id}}) is None
    assert next(o["status"] for o in state["otcOffers"] if o["id"] == fake_offer_id) == "scam_prevented"
    print("✓ Фейковый гарант @Garant_KMl успешно разоблачён, капитал защищён!")

    print("\n=== ТЕСТ 6: Снятие 115-ФЗ через Гришу Бухгалтера ===")
    state["banks"]["sber"]["status"] = "appeal_needed"
    assert engine.do_action(state, {"type": "bank_appeal", "payload": {"bankId": "sber"}}) is None
    assert state["banks"]["sber"]["status"] == "ok"
    print("✓ Пакет документов Гриши Бухгалтера снял ограничения банка по 115-ФЗ.")

    print("\n=== ТЕСТ 7: Прохождение глав до Главы 8 ===")
    # Наращиваем капитал для продвижения по главам
    state["rub"] = 40000.0
    engine._check_chapter(state)
    assert state["chapter"] == 3
    print("✓ Глава 3 достигнута (капитал 40 000 ₽, первый миллион оборота).")

    state["rub"] = 150000.0
    engine._check_chapter(state)
    assert state["chapter"] == 4
    assert state["city"] == "MOSCOW"
    print("✓ Глава 4 достигнута (капитал 150 000 ₽, переезд в Москву к Марату KMI).")

    state["rub"] = 400000.0
    engine._check_chapter(state)
    assert state["chapter"] == 5
    print("✓ Глава 5 достигнута (капитал 400 000 ₽, сбор синдиката команды).")

    state["rub"] = 1200000.0
    engine._check_chapter(state)
    assert state["chapter"] == 6
    print("✓ Глава 6 достигнута (капитал 1 200 000 ₽, масштабирование).")

    state["rub"] = 3000000.0
    engine._check_chapter(state)
    assert state["chapter"] == 7
    print("✓ Глава 7 достигнута (капитал 3 000 000 ₽, регистрация ИП и победа над Максом).")

    state["rub"] = 10000000.0
    engine._check_chapter(state)
    assert state["chapter"] == 8
    print("✓ Глава 8 достигнута (капитал 10 000 000 ₽, генеральный проект Марата KMI).")

    print("\n=== ТЕСТ 8: Все 4 канонических финала ===")
    # 1. Архитектор системы
    s1 = copy.deepcopy(state)
    s1["isIpRegistered"] = True
    s1["trust"]["marat"] = 80
    s1["trust"]["karim"] = 80
    s1["trust"]["pasha"] = 80
    assert engine.do_action(s1, {"type": "choice", "payload": {"choiceId": "ending_white_system"}}) is None
    assert s1["ending"]["category"] == "ARCHITECT"
    print("✓ Финал 1: «%s»" % s1["ending"]["title"])

    # 2. Финансовый кризис (Империя на песке)
    s2 = copy.deepcopy(state)
    assert engine.do_action(s2, {"type": "choice", "payload": {"choiceId": "ending_leverage_all_in"}}) is None
    assert s2["ending"]["category"] == "CRISIS"
    print("✓ Финал 2: «%s»" % s2["ending"]["title"])

    # 3. Одиночество на вершине
    s3 = copy.deepcopy(state)
    s3["isIpRegistered"] = False
    s3["trust"]["karim"] = 20
    s3["trust"]["pasha"] = 25
    assert engine.do_action(s3, {"type": "choice", "payload": {"choiceId": "ending_white_system"}}) is None
    assert s3["ending"]["category"] == "SOLO"
    print("✓ Финал 3: «%s»" % s3["ending"]["title"])

    # 4. Новый старт
    s4 = copy.deepcopy(state)
    s4["rub"] = 250000.0
    s4["isIpRegistered"] = False
    assert engine.do_action(s4, {"type": "choice", "payload": {"choiceId": "ending_white_system"}}) is None
    assert s4["ending"]["category"] == "RESTART"
    print("✓ Финал 4: «%s»" % s4["ending"]["title"])

    print("\n==============================================")
    print("ВСЕ 8 ЭТАПОВ СЦЕНАРИЯ И 4 ФИНАЛА ПРОЙДЕНЫ УСПЕШНО!")
    print("==============================================")


if __name__ == "__main__":
    run_full_scenario_test()
