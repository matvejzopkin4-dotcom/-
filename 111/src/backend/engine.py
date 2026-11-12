# -*- coding: utf-8 -*-
"""Игровой движок «P2P: С НУЛЯ» — состояние, формулы раздела 6 GDD, действия.

Только stdlib. Состояние игры — обычный dict, сервер (app.py) хранит его
в памяти процесса. Все проверки валидности выполняются ДО изменения состояния:
при ошибке состояние остаётся прежним.
Поддерживает прохождение всех 8 глав, 9 персонажей, TG-Hub, банковский
комплаенс (115-ФЗ / 161-ФЗ), инспектор сделок, арбитраж и 4 концовки.
"""
import copy
import json
import math
import os
import random
import sys
import threading
from decimal import Decimal, DecimalException, ROUND_HALF_UP

ACTION_LOCK = threading.RLock()

DATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")

# Константы экономики (раздел 6 GDD)
TAU = 0.13            # налоговый резерв (УСН/НДФЛ, подтверждённые расходы)
C_OVERHEAD = 0.0      # накладные расходы на сделку
C_GAS = 0.0           # сетевая комиссия (внутрибиржевая сделка)
ENERGY_PER_DEAL = 5
STRESS_PER_DEAL = 3
GRISHA_TRUST_FOR_TAX = 70  # Гриша ведёт учёт -> включается налоговый резерв

with open(DATA_PATH, encoding="utf-8") as f:
    DATA = json.load(f)


# ---------------------------------------------------------------------------
# Формулы раздела 6 GDD (чистая функция — используется и тестами)
# ---------------------------------------------------------------------------
def calc_cycle(v_rub, p_buy, p_sell, f_bank_in=0.0, f_m1=0.0, f_m2=0.0,
               c_gas=0.0, c_overhead=0.0, tau=TAU):
    """Полный цикл P2P/арбитража по формулам 6.2. Возвращает словарь."""
    for name, value in (("v_rub", v_rub), ("p_buy", p_buy), ("p_sell", p_sell),
                        ("f_bank_in", f_bank_in), ("f_m1", f_m1), ("f_m2", f_m2),
                        ("c_gas", c_gas), ("c_overhead", c_overhead), ("tau", tau)):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("%s должен быть конечным числом" % name)
    if v_rub < 0 or p_buy <= 0 or p_sell <= 0 or c_gas < 0 or c_overhead < 0:
        raise ValueError("Недопустимые объём, курс или расходы")
    if any(not 0 <= f <= 1 for f in (f_bank_in, f_m1, f_m2, tau)):
        raise ValueError("Комиссии и налог задаются долями от 0 до 1")
    q_usdt = (v_rub * (1 - f_bank_in) / p_buy) * (1 - f_m1)
    q_net = max(0.0, q_usdt - c_gas)
    r_rub = q_net * (1 - f_m2) * p_sell
    pnl_gross = r_rub - v_rub - c_overhead
    pnl_net = pnl_gross * (1 - tau) if pnl_gross > 0 else pnl_gross
    s_eff = (pnl_net / v_rub * 100.0) if v_rub else 0.0
    return {
        "qUsdt": q_usdt, "qNet": q_net, "rRub": r_rub,
        "pnlGross": pnl_gross, "pnlNet": pnl_net, "sEff": s_eff,
    }


# ---------------------------------------------------------------------------
# Состояние
# ---------------------------------------------------------------------------
def _strip_options(messages):
    """Варианты ответа в state — только id и text (без служебных полей)."""
    out = []
    for m in messages:
        out.append({
            "from": m["from"],
            "text": m["text"],
            "options": [{"id": o["id"], "text": o["text"]} for o in m.get("options", [])],
        })
    return out


def new_state():
    trust = {c["id"]: c["trustStart"] for c in DATA["characters"]}
    chats = {}
    for ch in DATA["chats"]:
        chats[ch["id"]] = {
            "title": ch["title"],
            "messages": _strip_options(ch["messages"]),
        }
    
    # Банковские счета
    banks_state = {}
    for b in DATA["banks"]:
        banks_state[b["id"]] = {
            "name": b["name"],
            "balanceRub": 3700.0 if b["id"] == "tbank" else 0.0,
            "usedSbp": 0.0,
            "freeSbpLimit": b["sbpFreeLimit"],
            "riskScore": 15,
            "status": "ok",  # ok | cooling | appeal_needed | blocked
            "appealDaysLeft": 0,
        }

    return {
        "day": 1,
        "chapter": 1,
        "city": "NOVOZAROVSK",
        "rub": 3700.0,
        "usdt": 0.0,
        "energy": 100.0,
        "stress": 0.0,
        "focus": 50.0,
        "trust": trust,
        "log": [{"day": 1, "text": "Новозаровск. На карте 3700 RUB. Начинаем с нуля."}],
        "chats": chats,
        "deals": [],
        "ownedProperties": [],
        # расширенное состояние
        "turnoverRub": 0.0,
        "taxReserveRub": 0.0,
        "isIpRegistered": False,
        "taxMode": "НДФЛ 13%",
        "banks": banks_state,
        "activeHustlesDone": [],
        "activeOrder": _generate_order(1, 91.0, 92.0),
        "otcOffers": _generate_otc_offers(),
        "ending": None,
        # служебное (для тестов и первого эпизода):
        "avgCostRub": 0.0,
        "costBasisRub": 0.0,
        "episode": {
            "stage": "intro",
            "pendingUsdt": 0.0,
            "bought": False,
            "usedChoices": [],
            "outcome": "",
            "chapterScene": "ch1_start"
        },
        "messages": [{"author": "Даня", "text": DATA["episode"]["greeting"]}],
    }


def _log(state, text):
    state["log"].append({"day": state["day"], "text": text})


def _money(value):
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _message(state, author, text):
    state["messages"].append({"author": author, "text": text})


def _generate_order(chapter, buy_rate, sell_rate):
    """Генерация входящей заявки для Инспектора сделок."""
    names = [
        ("Алексей Смирнов", "Алексей С.", True, True),
        ("Дмитрий Ковалёв", "Дмитрий К.", True, True),
        ("Сергей Морозов", "Магомед И.", False, True),  # Третье лицо / дроп!
        ("Артур Багиров", "Артур Б.", True, False),     # Поддельный чек!
        ("Елена Васильева", "Елена В.", True, True),
        ("Игорь Паньков", "Игорь П.", True, True),
    ]
    name, sender, is_match, receipt_valid = random.choice(names)
    qty = 30.0 if chapter <= 2 else random.choice([50.0, 100.0, 250.0, 500.0])
    rate = sell_rate if random.random() > 0.3 else sell_rate + 0.15
    total = _money(qty * rate)
    return {
        "orderId": "ORD-%d" % random.randint(10000, 99999),
        "counterpartyName": name,
        "bankSender": sender,
        "isCounterpartyMatch": is_match,
        "isReceiptAuthentic": receipt_valid,
        "amountUsdt": qty,
        "priceRub": rate,
        "totalRub": total,
        "bankId": random.choice(["tbank", "sber", "alfa"]),
        "status": "pending",  # pending | confirmed | reported
    }


def _generate_otc_offers():
    """Заявки на OTC-доске от Капула с механикой гаранта."""
    return [
        {
            "id": "otc_1",
            "title": "Оптовый выкуп 2 500 USDT (наличные / СБП)",
            "volumeUsdt": 2500,
            "rateRub": 92.40,
            "totalRub": 231000,
            "creator": "@kapul_connect",
            "guarantor": "@Garant_KMI",
            "isGuarantorLegit": True,
            "status": "available",
            "description": "Сделка через официального гаранта пула KMI. Быстрый расчет."
        },
        {
            "id": "otc_2",
            "title": "Срочный обмен 5 000 USDT (+1.8% к бирже)",
            "volumeUsdt": 5000,
            "rateRub": 93.65,
            "totalRub": 468250,
            "creator": "@crypto_wolf_msk",
            "guarantor": "@Garant_KMl",  # Фейк! Буква l вместо I
            "isGuarantorLegit": False,
            "status": "available",
            "description": "Подозрительно высокий спред. Внимание на никнейм гаранта!"
        },
        {
            "id": "otc_3",
            "title": "B2B агентский пул 10 000 USDT под контракт ИП",
            "volumeUsdt": 10000,
            "rateRub": 92.15,
            "totalRub": 921500,
            "creator": "@aifory_agent",
            "guarantor": "@Garant_KMI",
            "isGuarantorLegit": True,
            "status": "available",
            "description": "Только по безналу с закрывающими актами Гриши Бухгалтера."
        }
    ]


# ---------------------------------------------------------------------------
# Сюжет и эпизоды
# ---------------------------------------------------------------------------
def _episode_trade(state, side, quantity):
    episode = state["episode"]
    if episode["stage"] != "trade":
        return
    if side == "buy":
        episode["bought"] = True
        episode["pendingUsdt"] = round(episode["pendingUsdt"] + quantity, 6)
    elif episode["bought"]:
        episode["pendingUsdt"] = round(max(0.0, episode["pendingUsdt"] - quantity), 6)
        if episode["pendingUsdt"] == 0 and state["usdt"] == 0:
            episode["stage"] = "decision"
            _message(state, "Даня", "Круг закрыт: USDT проданы, результат уже в рублях. Что возьмёшь за правило после первой сделки?")
            _log(state, "Первый круг покупки и продажи завершён. Осталось принять решение.")


def _do_choice(state, payload):
    episode = state["episode"]
    choice_id = payload.get("choiceId")
    available = _episode_choices(state)
    if not isinstance(choice_id, str) or not any(c["id"] == choice_id for c in available):
        return "Этот выбор недоступен или уже использован"
    if choice_id in episode["usedChoices"]:
        return "Этот выбор уже использован"
    
    # Режим первого обучающего эпизода Главы 1
    if state["chapter"] == 1 and episode["stage"] in ("intro", "decision") and not choice_id.startswith(("story_", "ending_")):
        key = "introChoices" if episode["stage"] == "intro" else "finalChoices"
        choice = _find(DATA["episode"][key], choice_id)
        if choice is None:
            return "Вариант выбора не найден"
        episode["usedChoices"].append(choice_id)
        _message(state, "Артём", choice["label"])
        _message(state, "Даня", choice["reply"])
        if episode["stage"] == "intro":
            episode["stage"] = "trade"
            state["trust"]["danya"] = _clamp(state["trust"]["danya"] + (5 if choice_id == "opt_thanks" else 10))
            if choice_id == "opt_bold":
                state["trust"]["karim"] = _clamp(state["trust"]["karim"] - 5)
            chat = state["chats"]["chat_local"]
            if chat["messages"] and chat["messages"][0].get("options"):
                chat["messages"][0]["options"] = []
            chat["messages"].append({"from": "Артём", "text": choice["label"], "options": []})
            chat["messages"].append({"from": "Даня ММА", "text": choice["reply"], "options": []})
            _log(state, "Знакомство с Даней. Цель: купить USDT и завершить продажу.")
        else:
            episode["stage"] = "completed"
            episode["outcome"] = choice["outcome"]
            _log(state, "Эпизод завершён. " + choice["outcome"])
            _check_chapter(state)
        return None

    # Продвинутые сюжетные выборы глав (2–8)
    return _do_storyline_choice(state, choice_id)


def _do_storyline_choice(state, choice_id):
    """Сюжетные развилки для последующих глав (2–8)."""
    episode = state["episode"]
    episode["usedChoices"].append(choice_id)

    if choice_id == "story_ch2_start":
        _log(state, "Глава 2: Саня Лимит прислал связку с Т-Банком.")
        _message(state, "Саня Лимит", "Смотри стакан Bybit: закупаем по 91.0, ставим ордер на продажу по 92.0 через Т-Банк. Чистыми выйдет +74 рубля с круга!")
    elif choice_id == "story_ch3_marat":
        _log(state, "Глава 3: Ответ Марату KMI в чате.")
        state["trust"]["marat"] = _clamp(state["trust"]["marat"] + 15)
        _message(state, "Марат KMI", "Вижу, что не витаешь в облаках. Приезжай в Москву — поговорим о Unit-экономике.")
    elif choice_id == "story_ch4_cafe":
        _log(state, "Глава 4: Встреча с Маратом на Пресне.")
        state["city"] = "MOSCOW"
        state["trust"]["marat"] = _clamp(state["trust"]["marat"] + 10)
        state["trust"]["karim"] = _clamp(state["trust"]["karim"] + 10)
        _message(state, "Марат KMI", "Запомни: валовый оборот греет эго, а чистая прибыль кормит семью. Учись считать каждую комиссию.")
    elif choice_id == "story_ch5_team":
        _log(state, "Глава 5: Совет команды. Отказ от токсичного плеча Ролекса.")
        state["trust"]["karim"] = _clamp(state["trust"]["karim"] + 15)
        state["trust"]["pasha"] = _clamp(state["trust"]["pasha"] + 10)
        state["trust"]["ivan"] = _clamp(state["trust"]["ivan"] - 10)
        _message(state, "Карим", "Грамотное решение. Заёмное плечо при текущей волатильности привело бы к ликвидации.")
    elif choice_id == "story_ch6_audit":
        _log(state, "Глава 6: Гриша Бухгалтер подготовил ответ по 115-ФЗ.")
        state["trust"]["grisha"] = _clamp(state["trust"]["grisha"] + 20)
        state["stress"] = _clamp(state["stress"] - 25)
        for b in state["banks"].values():
            b["riskScore"] = max(10, b["riskScore"] - 40)
            b["status"] = "ok"
        _message(state, "Гриша Бухгалтер", "Банк принял выписки и КУДиР! Дистанционное обслуживание разблокировано.")
    elif choice_id == "story_ch7_ip":
        _log(state, "Глава 7: Регистрация ИП на УСН 15% (доходы минус расходы).")
        state["isIpRegistered"] = True
        state["taxMode"] = "УСН 15%"
        state["trust"]["marat"] = _clamp(state["trust"]["marat"] + 15)
        _message(state, "Артём", "Мы работаем в белую. Демпинг Макса Ноля нам не страшен — институционалы идут к нам.")
    elif choice_id.startswith("ending_"):
        _evaluate_ending(state, choice_id)
    return None


def _evaluate_ending(state, choice_id):
    """Расчёт одного из 4 канонических финалов GDD."""
    rub = state["rub"]
    marat_trust = state["trust"].get("marat", 0)
    karim_trust = state["trust"].get("karim", 0)
    pasha_trust = state["trust"].get("pasha", 0)
    is_white = state.get("isIpRegistered", False)

    if choice_id == "ending_leverage_all_in":
        # Иван Ролекс победил: империя на песке
        state["ending"] = {
            "title": "Финансовый кризис (Империя на песке)",
            "category": "CRISIS",
            "text": "По совету Ивана Ролекса команда зашла в сделку с заёмным 10-кратным плечом. Внезапный запрос документов по 115-ФЗ заблокировал счета в трёх банках одновременно. Наступил кассовый разрыв. Деньги сгорели, команда распалась.",
            "status": "Поражение из-за неоправданного риска"
        }
    elif marat_trust >= 50 and karim_trust >= 50 and pasha_trust >= 50 and is_white:
        # Лучший канонический финал: Архитектор системы
        state["ending"] = {
            "title": "Устойчивый бизнес (Архитектор системы)",
            "category": "ARCHITECT",
            "text": "Артём построил прозрачную, юридически безупречную компанию с филиалом в Москве и глубоким пулом ликвидности. Марат KMI передаёт управление региональным фондом Артёму. Команда сплочена, бухгалтерия в порядке.",
            "status": "Идеальная победа: баланс капитала и человечности"
        }
    elif rub >= 5000000 and (karim_trust < 40 or pasha_trust < 40):
        # Одиночество на вершине
        state["ending"] = {
            "title": "Одиночество на вершине",
            "category": "SOLO",
            "text": "На балансе миллионы, но жёсткие авторитарные решения выжгли команду. Даня вернулся в спортзал, Паша ушёл в другую безопасность, Карим устроился в хедж-фонд. Деньги есть, но разделить успех не с кем.",
            "status": "Финансовый триумф ценой дружбы"
        }
    else:
        # Новый старт
        state["ending"] = {
            "title": "Новый старт",
            "category": "RESTART",
            "text": "Шок на рынке скосил оборотный капитал, но Артём до копейки рассчитался со всеми партнёрами и сотрудниками. Марат KMI жмёт руку: «Ты сохранил главное — своё имя. Деньги мы заработаем снова. Начинаем следующий уровень».",
            "status": "Честное имя и надёжный тыл для нового рывка"
        }
    _log(state, "ИТОГ ИГРЫ: " + state["ending"]["title"])


def _episode_choices(state):
    stage = state["episode"]["stage"]
    if state["chapter"] == 1 and stage != "completed":
        key = {"intro": "introChoices", "decision": "finalChoices"}.get(stage)
        return ([{"id": c["id"], "label": c["label"]} for c in DATA["episode"][key]]
                if key else [])
    if state["chapter"] == 1 and stage == "completed":
        return []
    
    # Для последующих глав (2–8)
    ch = state["chapter"]
    choices = []
    used = state["episode"].get("usedChoices", [])
    if ch == 2:
        if "story_ch2_start" not in used:
            choices.append({"id": "story_ch2_start", "label": "Разобрать стакан Bybit и СБП вместе с Саней Лимитом"})
    elif ch == 3:
        if "story_ch3_marat" not in used:
            choices.append({"id": "story_ch3_marat", "label": "Честно ответить Марату KMI о комиссиях и марже"})
    elif ch == 4:
        if "story_ch4_cafe" not in used:
            choices.append({"id": "story_ch4_cafe", "label": "Поехать на встречу с Маратом KMI в Москву"})
    elif ch == 5:
        if "story_ch5_team" not in used:
            choices.append({"id": "story_ch5_team", "label": "Отклонить токсичное кредитное плечо Ролекса на совете"})
    elif ch == 6:
        if "story_ch6_audit" not in used:
            choices.append({"id": "story_ch6_audit", "label": "Подать белое пояснение в банк через Гришу Бухгалтера"})
    elif ch == 7:
        if "story_ch7_ip" not in used:
            choices.append({"id": "story_ch7_ip", "label": "Зарегистрировать ИП (УСН 15%) и победить демпинг Макса"})
    elif ch == 8 and not state.get("ending"):
        choices.append({"id": "ending_white_system", "label": "Войти в KMI Private Flow по белой модели (Архитектор)"})
        choices.append({"id": "ending_leverage_all_in", "label": "Взять всё доступное плечо по совету Ролекса (Риск)"})
    return choices


def play_view(state):
    """Чистое представление: чтение не создаёт сообщений или наград."""
    episode = state["episode"]
    stage = episode["stage"]
    
    if state["chapter"] == 1:
        objectives = {
            "intro": "Познакомься с Даней и ответь на его предложение.",
            "trade": "Купи USDT и полностью продай купленный объём.",
            "decision": "Обсуди результат с Даней и выбери следующий шаг.",
            "completed": episode["outcome"] or "Первый опыт получен.",
        }
        texts = {
            "intro": DATA["episode"]["greeting"],
            "trade": "Покупка — ещё не прибыль. Заверши круг продажей; каждая операция стоит 5 энергии.",
            "decision": "Первый круг закрыт. Реши, что для тебя важнее после первой сделки.",
            "completed": "Первый опыт получен. " + (episode["outcome"] or ""),
        }
        progress = {"intro": 0, "trade": 1, "decision": 2, "completed": 3}[stage]
        return {
            "day": state["day"],
            "chapter": state["chapter"],
            "rub": state["rub"],
            "usdt": state["usdt"],
            "energy": state["energy"],
            "pnlNet": _money(sum(d["pnlNet"] for d in state["deals"])),
            "market": {"buyRate": DATA["episode"]["buyRate"], "sellRate": DATA["episode"]["sellRate"]},
            "items": [
                {"id": p["id"], "title": p["name"], "price": p["priceRub"],
                 "owned": p["id"] in state["ownedProperties"]} for p in DATA["properties"]
            ],
            "story": {
                "sceneId": "first_" + stage,
                "title": DATA["episode"]["title"],
                "text": texts[stage],
                "objective": objectives[stage],
                "progress": progress,
                "target": 3,
                "choices": _episode_choices(state),
                "completed": stage == "completed",
            },
            "messages": [{"id": "message_%d" % i, **m} for i, m in enumerate(state["messages"])],
            "log": [
                {"id": "log_%d" % i, "text": entry["text"],
                 "kind": "success" if entry["text"].startswith(("Покупка", "Продажа", "Куплено", "Эпизод завершён", "Разблокировано", "ИТОГ"))
                         else ("error" if "Отклонено" in entry["text"] or "Ошибка" in entry["text"] or "115-ФЗ" in entry["text"] else "info")}
                for i, entry in enumerate(state["log"])
            ],
        }

    # Для глав 2–8:
    cur_ch = DATA["chapters"][state["chapter"] - 1]
    is_done = state["chapter"] == 8 and state.get("ending") is not None
    return {
        "day": state["day"],
        "chapter": state["chapter"],
        "rub": state["rub"],
        "usdt": state["usdt"],
        "energy": state["energy"],
        "pnlNet": _money(sum(d["pnlNet"] for d in state["deals"])),
        "market": {"buyRate": 91.20, "sellRate": 92.15},
        "items": [
            {"id": p["id"], "title": p["name"], "price": p["priceRub"],
             "owned": p["id"] in state["ownedProperties"]} for p in DATA["properties"]
        ],
        "story": {
            "sceneId": "scene_ch%d" % state["chapter"],
            "title": cur_ch["title"],
            "text": cur_ch["description"],
            "objective": cur_ch["goal"],
            "progress": min(state["rub"], cur_ch["nextRub"]),
            "target": cur_ch["nextRub"],
            "choices": _episode_choices(state),
            "completed": is_done,
        },
        "messages": [{"id": "message_%d" % i, **m} for i, m in enumerate(state["messages"])],
        "log": [
            {"id": "log_%d" % i, "text": entry["text"],
             "kind": "success" if entry["text"].startswith(("Покупка", "Продажа", "Куплено", "Эпизод", "Разблокировано", "ИТОГ"))
                     else ("error" if "Отклонено" in entry["text"] or "Ошибка" in entry["text"] or "115-ФЗ" in entry["text"] else "info")}
            for i, entry in enumerate(state["log"])
        ],
    }


def play_action(state, action):
    if not isinstance(action, dict) or not isinstance(action.get("type"), str):
        return "Ожидается объект с типом действия"
    kind = action["type"]
    fields = {
        "buy": {"type", "amount"},
        "sell": {"type", "amount"},
        "purchase": {"type", "itemId"},
        "choice": {"type", "choiceId"},
        "advance_day": {"type"},
        "hustle": {"type", "hustleId"},
        "inspect_order": {"type", "decision"},
        "verify_guarantor": {"type", "offerId"},
        "bank_appeal": {"type", "bankId"},
        "team_action": {"type", "actionId"}
    }
    if kind not in fields or set(action) != fields[kind]:
        return "Неизвестный тип или неверные поля действия"
    
    if kind in ("buy", "sell"):
        rate = DATA["episode"]["buyRate" if kind == "buy" else "sellRate"]
        legacy = {"type": "deal", "payload": {
            "side": kind, "amountUsdt": action["amount"],
            "priceRub": rate, "exchange": "bybit", "bank": "tbank"
        }}
    elif kind == "purchase":
        legacy = {"type": "buy_property", "payload": {"propertyId": action["itemId"]}}
    elif kind == "choice":
        legacy = {"type": "choice", "payload": {"choiceId": action["choiceId"]}}
    elif kind == "hustle":
        legacy = {"type": "hustle", "payload": {"hustleId": action["hustleId"]}}
    elif kind == "inspect_order":
        legacy = {"type": "inspect_order", "payload": {"decision": action["decision"]}}
    elif kind == "verify_guarantor":
        legacy = {"type": "verify_guarantor", "payload": {"offerId": action["offerId"]}}
    elif kind == "bank_appeal":
        legacy = {"type": "bank_appeal", "payload": {"bankId": action["bankId"]}}
    elif kind == "team_action":
        legacy = {"type": "team_action", "payload": {"actionId": action["actionId"]}}
    else:
        legacy = {"type": "advance_day"}
    return do_action(state, legacy)


def _clamp(v, lo=0.0, hi=100.0):
    return max(lo, min(hi, v))


def _check_chapter(state):
    """Смена главы по порогу RUB (раздел 3 GDD)."""
    chapters = DATA["chapters"]
    while state["chapter"] < len(chapters):
        cur = chapters[state["chapter"] - 1]
        if state["rub"] < cur["nextRub"]:
            break
        state["chapter"] += 1
        nxt = chapters[state["chapter"] - 1]
        state["city"] = nxt.get("city", state.get("city", "MOSCOW"))
        _log(state, "Глава %d: «%s». Цель: %s" % (nxt["id"], nxt["title"], nxt["goal"]))
        _message(state, "Система", "🎉 Достигнута новая глава: %s! Город: %s." % (nxt["title"], state["city"]))


def _tax_rate(state):
    """tau=0.13/0.15, когда Гриша ведёт учёт (доверие >= 70); до того резерв 0."""
    return TAU if state["trust"].get("grisha", 0) >= GRISHA_TRUST_FOR_TAX else 0.0


def _fat_finger(state, volume, unit="RUB"):
    """Стресс > 75: шанс ошибки «толстого пальца» — потеря 1-2% объёма."""
    if state["stress"] <= 75:
        return volume, None
    if random.random() < (state["stress"] - 75) / 100.0:
        loss_pct = random.uniform(1.0, 2.0)
        lost = volume * loss_pct / 100.0
        return volume - lost, "Ошибка толстого пальца: потеряно %.2f %s (%.1f%% объёма)" % (lost, unit, loss_pct)
    return volume, None


# ---------------------------------------------------------------------------
# Обработчики действий
# ---------------------------------------------------------------------------
def _find(list_, id_):
    for item in list_:
        if item["id"] == id_:
            return item
    return None


def _do_deal(state, payload):
    side = payload.get("side")
    amount = payload.get("amountUsdt")
    price = payload.get("priceRub")
    if side not in ("buy", "sell"):
        return "Неизвестная сторона сделки: %r" % (side,)
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount) or amount <= 0:
        return "Объём USDT должен быть положительным конечным числом"
    if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 0:
        return "Курс должен быть положительным конечным числом"
    if not math.isfinite(amount * price):
        return "Слишком большой объём сделки"
    exchange = _find(DATA["exchanges"], payload.get("exchange"))
    bank = _find(DATA["banks"], payload.get("bank"))
    if exchange is None:
        return "Неизвестная биржа"
    if bank is None:
        return "Неизвестный банк"
    if state["energy"] < ENERGY_PER_DEAL:
        return "Слишком мало энергии для сделки"

    if side == "sell" and amount > state["usdt"]:
        return "Недостаточно USDT: есть %.6f" % state["usdt"]
    amount = round(float(amount), 6)
    price = float(price)
    if amount <= 0 or _money(amount * price) <= 0:
        return "Объём сделки меньше точности учёта"
    if state["chapter"] == 1:
        expected = DATA["episode"]["buyRate" if side == "buy" else "sellRate"]
        if price != expected:
            return "Курс первого эпизода задаётся сервером: %s" % expected
    fee_m = exchange["feeMaker"]

    # Проверка антифрод-статуса банка
    b_state = state.get("banks", {}).get(bank["id"])
    if b_state and b_state["status"] == "blocked":
        return "Счёт в банке %s заблокирован по 115-ФЗ. Требуется комплаенс-разблокировка." % bank["name"]

    if side == "buy":
        v_rub = _money(amount * price)
        if state["rub"] < v_rub:
            return "Недостаточно рублей: нужно %.2f, есть %.2f" % (v_rub, state["rub"])
        month = (state["day"] - 1) // 30
        usage = state.setdefault("bankUsage", {})
        usage_key = "%s:%d" % (bank["id"], month)
        used = usage.get(usage_key, 0.0)
        taxable = max(0.0, v_rub - max(0.0, bank["sbpFreeLimit"] - used))
        bank_fee = min(1500.0, taxable * bank["feeOver"])
        q = max(0.0, (amount - bank_fee / price) * (1 - fee_m) - C_GAS)
        q, err = (q, None) if state["chapter"] == 1 else _fat_finger(state, q, "USDT")
        q = round(q, 6)
        if q <= 0:
            return "После комиссий объём меньше точности учёта"
        basis = state.get("costBasisRub", state["usdt"] * state["avgCostRub"])
        state["costBasisRub"] = _money(basis + v_rub)
        usage[usage_key] = _money(used + v_rub)
        state["rub"] = _money(state["rub"] - v_rub)
        state["usdt"] = round(state["usdt"] + q, 6)
        state["avgCostRub"] = state["costBasisRub"] / state["usdt"]
        state["turnoverRub"] = _money(state.get("turnoverRub", 0.0) + v_rub)
        pnl_net = 0.0
        if err:
            _log(state, err)
        _log(state, "Покупка %.2f USDT по %.2f на %s (%s): потрачено %.2f RUB"
             % (q, price, exchange["name"], bank["name"], v_rub))
    else:  # sell
        if state["usdt"] < amount:
            return "Недостаточно USDT: есть %.6f" % state["usdt"]
        basis = state.get("costBasisRub", state["usdt"] * state["avgCostRub"])
        v_rub = basis if amount == state["usdt"] else _money(basis * amount / state["usdt"])
        r_rub = amount * (1 - fee_m) * price
        r_rub, err = (r_rub, None) if state["chapter"] == 1 else _fat_finger(state, r_rub)
        r_rub = _money(r_rub)
        pnl_gross = _money(r_rub - v_rub - C_OVERHEAD)
        tax_reserve = _money(pnl_gross * _tax_rate(state)) if pnl_gross > 0 else 0.0
        pnl_net = _money(pnl_gross - tax_reserve)
        state["usdt"] = round(state["usdt"] - amount, 6)
        state["costBasisRub"] = _money(basis - v_rub)
        state["rub"] = _money(state["rub"] + r_rub - C_OVERHEAD - tax_reserve)
        state["turnoverRub"] = _money(state.get("turnoverRub", 0.0) + r_rub)
        state["taxReserveRub"] = _money(state.get("taxReserveRub", 0.0) + tax_reserve)
        if state["usdt"] <= 1e-9:
            state["usdt"] = 0.0
            state["avgCostRub"] = 0.0
        _log(state, "Продажа %.2f USDT по %.2f на %s (%s): чистая прибыль %+.2f RUB"
             % (amount, price, exchange["name"], bank["name"], pnl_net))
        if err:
            _log(state, err)

    state["energy"] = _clamp(state["energy"] - ENERGY_PER_DEAL)
    state["stress"] = _clamp(state["stress"] + STRESS_PER_DEAL)
    
    # Обновление антифрод-скоринга банка (раздел 6.4)
    if b_state:
        b_state["riskScore"] = min(100, b_state["riskScore"] + random.randint(2, 5))
        if b_state["riskScore"] >= 88:
            b_state["status"] = "blocked"
            _log(state, "Внимание! Банк %s ограничил ДБО по 115-ФЗ из-за частых транзитов." % bank["name"])
        elif b_state["riskScore"] >= 70:
            b_state["status"] = "appeal_needed"

    state["deals"].append({
        "day": state["day"], "side": side,
        "amountUsdt": round(amount, 6), "priceRub": price,
        "pnlNet": round(pnl_net, 2),
    })
    _episode_trade(state, side, q if side == "buy" else amount)
    _check_chapter(state)
    return None


def _do_rest(state, payload):
    state["energy"] = _clamp(state["energy"] + 30)
    state["stress"] = _clamp(state["stress"] - 20)
    state["focus"] = _clamp(state["focus"] + 5)
    _log(state, "Отдых: энергия восстановлена, стресс снижен.")
    return None


def _do_advance_day(state, payload):
    state["day"] += 1
    state["energy"] = 100.0
    state["stress"] = _clamp(state["stress"] - 10)
    
    # Ежедневное списание содержания имущества (Burn Rate)
    burn = sum(DATA["properties"][i]["monthlyBurn"] for i in _prop_index(state)) / 30.0
    if burn > 0:
        state["rub"] = _money(max(0.0, state["rub"] - burn))
        _log(state, "Новый день. Расходы на содержание имущества: -%.2f RUB" % burn)
    else:
        _log(state, "Новый день %d." % state["day"])

    # Сброс лимитов СБП в начале нового месяца
    if state["day"] % 30 == 1:
        for b in state.get("banks", {}).values():
            b["usedSbp"] = 0.0
        _log(state, "Начался новый месяц: лимиты переводов по СБП обновлены.")

    # Генерация нового ордера для Инспектора сделок
    state["activeOrder"] = _generate_order(state["chapter"], 91.0, 92.0)
    _check_chapter(state)
    return None


def _prop_index(state):
    by_id = {p["id"]: i for i, p in enumerate(DATA["properties"])}
    return [by_id[pid] for pid in state["ownedProperties"] if pid in by_id]


def _do_buy_property(state, payload):
    prop = _find(DATA["properties"], payload.get("propertyId"))
    if prop is None:
        return "Неизвестное имущество"
    if prop["id"] in state["ownedProperties"]:
        return "Это имущество уже куплено"
    if state["rub"] < prop["priceRub"]:
        return "Недостаточно рублей: нужно %.2f, есть %.2f" % (prop["priceRub"], state["rub"])
    state["rub"] = _money(state["rub"] - prop["priceRub"])
    state["ownedProperties"].append(prop["id"])
    state["stress"] = _clamp(state["stress"] - 5)
    
    # Понты Ролекса злят Марата и Карима
    if prop["id"] == "luxury_car":
        state["trust"]["marat"] = _clamp(state["trust"]["marat"] - 15)
        state["trust"]["karim"] = _clamp(state["trust"]["karim"] - 15)
        state["trust"]["ivan"] = _clamp(state["trust"]["ivan"] + 25)
        _log(state, "Куплен спорткар в лизинг. Иван в восторге, но Марат недоволен тратой оборотного капитала.")
    elif prop["id"] == "laptop":
        state["focus"] = _clamp(state["focus"] + 25)
        _log(state, "Установлена рабочая станция с 2 мониторами. Внимательность к чекам повышена.")

    _log(state, "Куплено имущество: %s за %.2f RUB" % (prop["name"], prop["priceRub"]))
    _check_chapter(state)
    return None


def _do_chat_reply(state, payload):
    chat = state["chats"].get(payload.get("chatId"))
    if chat is None:
        return "Неизвестный чат"
    option_id = payload.get("optionId")
    if payload.get("chatId") == "chat_local" and option_id in ("opt_thanks", "opt_bold"):
        return _do_choice(state, {"choiceId": option_id})
    source = _find(DATA["chats"], payload.get("chatId"))
    for i, msg in enumerate(source["messages"]):
        opt = _find(msg.get("options", []), option_id)
        if opt is None or not chat["messages"][i].get("options"):
            continue
        for cid, delta in opt.get("trustDelta", {}).items():
            state["trust"][cid] = _clamp(state["trust"].get(cid, 50) + delta)
        chat["messages"][i]["options"] = []
        chat["messages"].append({"from": "Артём", "text": opt["text"], "options": []})
        if opt["id"] in ("opt_drop", "opt_maybe"):
            warning = "Чужие карты — риск уголовной ответственности (ст. 187 УК РФ). Команда отказалась; доступны только собственные счета и подтверждающие документы."
            chat["messages"].append({"from": "Гриша Бухгалтер", "text": warning, "options": []})
            state["stress"] = _clamp(state["stress"] + 15)
            _log(state, warning)
        _log(state, "Ответ в чате «%s»." % chat["title"])
        return None
    return "Вариант ответа не найден или уже использован"


# ---------------------------------------------------------------------------
# Новые игровые механики: Подработки, Инспектор ордеров, Гарант, Комплаенс
# ---------------------------------------------------------------------------
def _do_hustle(state, payload):
    """Подработки в Главе 1 для накопления стартовых 10 000 руб."""
    hustle_id = payload.get("hustleId")
    hustles = {
        "loader": {"title": "Разгрузка спортивного питания с Даней", "reward": 1800.0, "energy": 25, "stress": 10, "once": False},
        "avito": {"title": "Продажа старой видеокарты на Авито", "reward": 3200.0, "energy": 10, "stress": 0, "once": True},
        "carwash": {"title": "Ночная смена на автомойке", "reward": 1500.0, "energy": 20, "stress": 8, "once": False},
        "courier": {"title": "Срочная доставка документов", "reward": 2200.0, "energy": 30, "stress": 5, "once": False},
    }
    h = hustles.get(hustle_id)
    if not h:
        return "Неизвестная подработка"
    if h["once"] and hustle_id in state.get("activeHustlesDone", []):
        return "Эта подработка уже выполнена"
    if state["energy"] < h["energy"]:
        return "Недостаточно энергии для подработки (нужно %d)" % h["energy"]

    state["energy"] = _clamp(state["energy"] - h["energy"])
    state["stress"] = _clamp(state["stress"] + h["stress"])
    state["rub"] = _money(state["rub"] + h["reward"])
    state.setdefault("activeHustlesDone", []).append(hustle_id)
    _log(state, "Подработка выполнена: %s (+%.2f RUB)" % (h["title"], h["reward"]))
    _check_chapter(state)
    return None


def _do_inspect_order(state, payload):
    """Проверка сделки в Инспекторе ордеров (защита от 161-ФЗ и фейковых PDF-чеков)."""
    decision = payload.get("decision")  # "confirm" | "appeal"
    order = state.get("activeOrder")
    if not order or order.get("status") != "pending":
        return "Нет активного ордера для проверки"

    is_safe = order["isCounterpartyMatch"] and order["isReceiptAuthentic"]

    if decision == "confirm":
        if is_safe:
            # Честный контрагент: зачисление средств
            profit = _money(order["totalRub"] * 0.015)
            state["rub"] = _money(state["rub"] + order["totalRub"])
            state["turnoverRub"] = _money(state.get("turnoverRub", 0.0) + order["totalRub"])
            order["status"] = "confirmed"
            state["focus"] = _clamp(state["focus"] + 5)
            _log(state, "Сделка %s подтверждена. ФИО и чек подлинные. Получено %.2f RUB" % (order["orderId"], order["totalRub"]))
        else:
            # Ошибка: отпустили крипту мошеннику! Блокировка 161-ФЗ
            penalty = _money(order["totalRub"])
            state["rub"] = _money(max(0.0, state["rub"] - penalty))
            state["stress"] = _clamp(state["stress"] + 35)
            for b in state.get("banks", {}).values():
                b["status"] = "blocked"
                b["riskScore"] = 95
            order["status"] = "fraud_hit"
            _log(state, "ТРЕВОГА! Платёж от 3-го лица без согласия. Реквизиты попали в базу ЦБ по 161-ФЗ! Карты заблокированы.")
    elif decision == "appeal":
        if not is_safe:
            # Успешное выявление мошенника!
            order["status"] = "reported"
            state["trust"]["pasha"] = _clamp(state["trust"]["pasha"] + 10)
            state["trust"]["grisha"] = _clamp(state["trust"]["grisha"] + 10)
            state["focus"] = _clamp(state["focus"] + 10)
            _log(state, "Внимание спасло деньги! Ордер %s отклонён: выявлено несовпадение ФИО (попытка треугольника)." % order["orderId"])
        else:
            # Ложная тревога
            order["status"] = "reported"
            _log(state, "Апелляция открыта по чистому ордеру. Контрагент недоволен задержкой.")

    state["activeOrder"] = _generate_order(state["chapter"], 91.0, 92.0)
    _check_chapter(state)
    return None


def _do_verify_guarantor(state, payload):
    """Проверка гаранта на OTC-доске."""
    offer_id = payload.get("offerId")
    offers = state.get("otcOffers", [])
    offer = _find(offers, offer_id)
    if not offer:
        return "Предложение OTC не найдено"

    if offer["isGuarantorLegit"]:
        profit = _money(offer["volumeUsdt"] * 0.8)
        state["rub"] = _money(state["rub"] + profit)
        offer["status"] = "completed"
        state["trust"]["kapul"] = _clamp(state["trust"]["kapul"] + 10)
        _log(state, "OTC сделка %s успешно закрыта через гаранта @Garant_KMI. Чистая прибыль: +%.2f RUB" % (offer["title"], profit))
    else:
        # Фейковый гарант распознан!
        offer["status"] = "scam_prevented"
        state["trust"]["karim"] = _clamp(state["trust"]["karim"] + 10)
        state["focus"] = _clamp(state["focus"] + 15)
        _log(state, "ВНИМАНИЕ! Распознан фейковый гарант @Garant_KMl (подмена буквы I на l). Капитал спасён!")

    _check_chapter(state)
    return None


def _do_bank_appeal(state, payload):
    """Подача комплаенс-документов через Гришу Бухгалтера для снятия 115-ФЗ."""
    bank_id = payload.get("bankId")
    b = state.get("banks", {}).get(bank_id)
    if not b:
        return "Банк не найден"
    if b["status"] == "ok":
        return "По счёту нет ограничений"

    # Гриша собирает документы
    b["status"] = "ok"
    b["riskScore"] = max(15, b["riskScore"] - 45)
    state["trust"]["grisha"] = _clamp(state["trust"]["grisha"] + 10)
    state["stress"] = _clamp(state["stress"] - 15)
    _log(state, "Гриша Бухгалтер подал КУДиР и выписки с Bybit в %s. Ограничения сняты!" % b["name"])
    return None


def _do_team_action(state, payload):
    """Взаимодействие с членами команды (RPG-элементы)."""
    action_id = payload.get("actionId")
    if action_id == "audit_karim":
        state["focus"] = _clamp(state["focus"] + 15)
        state["stress"] = _clamp(state["stress"] - 10)
        state["trust"]["karim"] = _clamp(state["trust"]["karim"] + 5)
        _log(state, "Аудит с Каримом: отсечены убыточные связки, риск скорректирован.")
    elif action_id == "security_pasha":
        state["focus"] = _clamp(state["focus"] + 20)
        state["trust"]["pasha"] = _clamp(state["trust"]["pasha"] + 5)
        _log(state, "Инструктаж безопасности с Пашей Борцом: антифрод-защита усилена.")
    elif action_id == "tax_grisha":
        state["trust"]["grisha"] = _clamp(state["trust"]["grisha"] + 10)
        _log(state, "Гриша свёл КУДиР за месяц: налоговый резерв сформирован в полном объёме.")
    elif action_id == "vip_ivan":
        bonus = random.randint(1500, 4500)
        state["rub"] = _money(state["rub"] + bonus)
        state["trust"]["ivan"] = _clamp(state["trust"]["ivan"] + 5)
        _log(state, "Иван Ролекс привёл VIP-клиента на экспресс-обмен (+%d RUB)." % bonus)
    else:
        return "Неизвестное действие команды"
    return None


ACTION_HANDLERS = {
    "deal": _do_deal,
    "rest": _do_rest,
    "advance_day": _do_advance_day,
    "buy_property": _do_buy_property,
    "chat_reply": _do_chat_reply,
    "choice": _do_choice,
    "hustle": _do_hustle,
    "inspect_order": _do_inspect_order,
    "verify_guarantor": _do_verify_guarantor,
    "bank_appeal": _do_bank_appeal,
    "team_action": _do_team_action,
}


def do_action(state, action):
    """Одна блокировка для проверки и фиксации любых действий."""
    with ACTION_LOCK:
        return _apply_action(state, action)


def _apply_action(state, action):
    """Выполняет действие. При ошибке возвращает текст, состояние не меняет."""
    if not isinstance(action, dict):
        return "Некорректное действие"
    action_type = action.get("type")
    if not isinstance(action_type, str) or action_type not in ACTION_HANDLERS:
        return "Неизвестный тип действия: %r" % (action_type,)
    payload = action.get("payload", {})
    if not isinstance(payload, dict):
        return "Некорректный payload"
    candidate = copy.deepcopy(state)
    try:
        error = ACTION_HANDLERS[action_type](candidate, payload)
    except (TypeError, ValueError, OverflowError, DecimalException):
        return "Некорректные параметры действия"
    if error:
        return error
    state.clear()
    state.update(candidate)
    return None
