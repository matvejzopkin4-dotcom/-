# -*- coding: utf-8 -*-
"""Автотесты экономики (раздел 6 GDD) для src/backend/engine.py.

Запуск: python tests/test_economy.py  (только stdlib, сервер не запускается).
Каждая проверка печатает строку OK/FAIL; в конце — ИТОГО.
"""
import os
import sys
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(HERE, "..", "src", "backend")
sys.path.insert(0, BACKEND)
sys.dont_write_bytecode = True
RESULTS = []


def check(name, fn):
    try:
        ok, detail = fn()
    except Exception as e:  # первое падение фиксируем и идём дальше
        ok, detail = False, "%s: %s" % (type(e).__name__, e)
    RESULTS.append((name, ok, detail))
    print(("OK   " if ok else "FAIL ") + name + (" — " + detail if detail else ""))


def _call_pnl(**kw):
    import engine
    return engine.calc_cycle(**kw)["pnlNet"]


def _new_state():
    import engine
    return engine.new_state()


def _get(state, *names, default=None):
    for n in names:
        if n in state:
            return state[n]
    return default


# ------------------------------ проверки ------------------------------

def c_reference():
    """Эталон: 1000 USDT buy 91.0 -> sell 92.0, все комиссии 0 -> PnL_net=1000.0."""
    pnl = _call_pnl(v_rub=91000.0, p_buy=91.0, p_sell=92.0, f_m1=0.0, f_m2=0.0,
                    f_bank_in=0.0, c_gas=0.0, c_overhead=0.0, tau=0.0)
    ok = abs(pnl - 1000.0) < 1e-6
    return ok, "PnL_net=%r" % (pnl,)


def c_fees():
    """С комиссиями: f_m1=f_m2=0.001, f_bank_in=0.005, C_gas=1, tau=0.13.

    Независимый ручной расчёт:
    Q_USDT = 91000*(1-0.005)/91*(1-0.001) = 994.005
    Q_net  = 994.005-1 = 993.005
    R      = 993.005*(1-0.001)*92 = 91265.10354
    PnL_gross = 265.10354; PnL_net = 265.10354*0.87 = 230.6400798
    Decimal и вручную вычисленные промежуточные значения независимы от движка.
    """
    manual = float((Decimal("91265.10354") - Decimal("91000")) * Decimal("0.87"))
    pnl = _call_pnl(v_rub=91000.0, p_buy=91.0, p_sell=92.0, f_m1=0.001, f_m2=0.001,
                    f_bank_in=0.005, c_gas=1.0, c_overhead=0.0, tau=0.13)
    ok = abs(pnl - manual) < 1e-6 * max(1.0, abs(manual))
    return ok, "PnL_net=%r, ручной расчёт=%r" % (pnl, manual)


def c_loss_no_tax():
    """Убыточная сделка: налог не применяется, PnL_net == PnL_gross."""
    # buy 91, sell 90: R = 1000*90 = 90000, gross = -1000
    pnl = _call_pnl(v_rub=91000.0, p_buy=91.0, p_sell=90.0, f_m1=0.0, f_m2=0.0,
                    f_bank_in=0.0, c_gas=0.0, c_overhead=0.0, tau=0.13)
    ok = abs(pnl - (-1000.0)) < 1e-6
    return ok, "PnL_net=%r (ожидалось -1000.0, без налога)" % (pnl,)


def c_qnet_clamp():
    """Q_net = max(0, Q_USDT - C_gas): газ съедает весь объём -> полный убыток V."""
    pnl = _call_pnl(v_rub=91000.0, p_buy=91.0, p_sell=92.0, f_m1=0.0, f_m2=0.0,
                    f_bank_in=0.0, c_gas=2000.0, c_overhead=0.0, tau=0.13)
    ok = abs(pnl - (-91000.0)) < 1e-6
    return ok, "PnL_net=%r (ожидалось -91000.0)" % (pnl,)


def c_zero_volume():
    """Нулевой объём: PnL_net = 0."""
    pnl = _call_pnl(v_rub=0.0, p_buy=91.0, p_sell=92.0, f_m1=0.0, f_m2=0.0,
                    f_bank_in=0.0, c_gas=0.0, c_overhead=0.0, tau=0.13)
    ok = abs(pnl) < 1e-9
    return ok, "PnL_net=%r" % (pnl,)


def c_start_state():
    """Стартовое состояние: rub=3700, energy=100."""
    s = _new_state()
    rub = _get(s, "rub")
    energy = _get(s, "energy")
    trust = s.get("trust", {})
    bad = ["trust.%s=%r (ожидалось %r)" % (k, trust.get(k), v)
           for k, v in GDD_TRUST.items() if trust.get(k) != v]
    ok = rub == 3700 and energy == 100 and not bad
    return ok, "rub=%r, energy=%r, trust=%r%s" % (
        rub, energy, trust, "; " + "; ".join(bad) if bad else "")


GDD_TRUST = {"marat": 30, "danya": 75, "pasha": 70, "ivan": 45, "kapul": 50,
             "karim": 55, "sanya": 60, "grisha": 50, "max": 10}


check("1. Эталонная сделка: PnL_net=1000.0", c_reference)
check("2. Сделка с комиссиями против ручного расчёта", c_fees)
check("3. Убыточная сделка не уменьшается налогом", c_loss_no_tax)
check("4. Q_net=max(0, Q_USDT-C_gas)", c_qnet_clamp)
check("5. Нулевой объём: PnL_net=0", c_zero_volume)
check("6. Старт: rub=3700, energy=100, trust по GDD", c_start_state)

passed = sum(1 for _, ok, _ in RESULTS if ok)
failed = len(RESULTS) - passed
print("ИТОГО: пройдено %d, упало %d (из %d)" % (passed, failed, len(RESULTS)))
sys.exit(1 if failed else 0)
