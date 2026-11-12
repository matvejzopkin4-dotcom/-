/* «P2P: С нуля» — игровой движок. Чистая логика без DOM.
   Состояние — простой JSON-объект (сохраняется в localStorage целиком).
   Все действия возвращают { ok, msg?, fx? } и меняют состояние только при успехе. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./data.js'));
  else root.P2PEngine = factory(root.P2PData);
})(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';

  const VERSION = 1;
  const ORDER_ENERGY = 10;
  const DISPUTE_ENERGY = 5;
  const ORDER_STRESS = 4;
  const EXCHANGE_FEE = 0.004;    // автодокупка/автопродажа на бирже
  const SBP_FREE = 100000;       // бесплатный лимит СБП третьим лицам за 30 дней
  const SBP_FEE = 0.01, SBP_FEE_CAP = 1500;
  const MID_BASE = 92;

  // ---------- RNG (mulberry32, состояние хранится в save) ----------
  function rnd(s) {
    let t = (s.seed = (s.seed + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const pick = (s, arr) => arr[Math.floor(rnd(s) * arr.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r2 = v => Math.round(v * 100) / 100;
  const fmt = v => Math.round(v).toLocaleString('ru-RU');

  // ---------- Состояние ----------
  function newGame(seed) {
    const s = {
      v: VERSION,
      seed: (seed == null ? Math.floor(Math.random() * 2 ** 31) : seed) | 0,
      day: 1, chapter: 1, chapterDay: 1,
      rub: 3700, usdt: 0,
      energy: 100, stress: 10, risk: 15, rep: 50,
      frozen: 0,
      trust: {}, team: [], upgrades: {}, flags: {},
      market: { mid: MID_BASE, hist: [] },
      orders: [], hustles: [], nextId: 1,
      pendingFraud: [],
      chat: [], pending: [], doneEvents: {},
      turnover: 0, profit: 0, taxOn: false, taxReserve: 0, taxDebt: 0, taxPaid: 0, fees: 0,
      sbpUsed: 0, buffs: [], retailDay: 0,
      today: { profit: 0, turnover: 0, orders: 0, nw0: 3700 },
      stats: { ordersDone: 0, caught: 0, scammed: 0, lost: 0, wrongDisputes: 0, frozenDays: 0, peak: 3700 },
      report: null, flash: null, ending: null,
    };
    for (const id in D.characters) s.trust[id] = D.characters[id].trust;
    for (let i = 0; i < 14; i++) moveMarket(s);
    startEvent(s, 'ch1_intro');
    rollHustles(s);
    return s;
  }

  const netWorth = s => s.rub + s.usdt * s.market.mid;
  const has = (s, id) => !!s.upgrades[id];
  const hired = (s, id) => s.team.includes(id);
  const maxEnergy = s => 100 + (hired(s, 'danya') ? 20 : 0);
  const orderEnergy = s => ORDER_ENERGY - (has(s, 'pc') ? 3 : 0);
  const taxRate = s => (s.flags.ip ? 0.15 : 0.13);
  const taxActive = s => s.chapter >= 4;
  const sbpLimit = s => SBP_FREE * (has(s, 'bank2') ? 3 : 1);

  function riskMult(s) {
    let m = 1;
    if (has(s, 'bank2')) m *= 0.7;
    if (s.flags.ip) m *= 0.5;
    if (hired(s, 'ivan')) m *= 1.2;
    return m;
  }

  function dailyCost(s) {
    let c = D.livingCost[s.chapter];
    for (const id in s.upgrades) c += D.upgrades[id].upkeep || 0;
    return c;
  }
  // Команда получает долю дневной прибыли (только если день в плюсе).
  const teamShare = s => s.team.reduce((a, id) => a + (D.characters[id].share || 0), 0);

  function goal(s) {
    const ch = D.chapters[s.chapter];
    const nw = netWorth(s);
    if (!ch.target) return { text: ch.goal, progress: s.ending ? 1 : 0.95, done: false };
    let progress = clamp(nw / ch.target, 0, 1);
    let done = nw >= ch.target;
    const extra = [];
    if (ch.hires) { extra.push(`команда ${s.team.length}/${ch.hires}`); if (s.team.length < ch.hires) { done = false; progress = Math.min(progress, 0.95); } }
    if (ch.flag) {
      const ok = !!s.flags[ch.flag];
      extra.push(ch.flag === 'ip' ? (ok ? 'ИП ✓' : 'ИП ✗') : (ok ? 'проверка ✓' : 'проверка ✗'));
      if (!ok) { done = false; progress = Math.min(progress, 0.95); }
    }
    return { text: ch.goal, target: ch.target, nw, progress, done, extra };
  }

  // ---------- Рынок ----------
  function gauss(s) { return (rnd(s) + rnd(s) + rnd(s) - 1.5) * 1.15; }
  function moveMarket(s) {
    const m = s.market;
    if (s.market.next != null) { m.mid = s.market.next; } else {
      m.mid = clamp(m.mid + (MID_BASE - m.mid) * 0.15 + gauss(s) * 0.7, 84, 101);
    }
    m.mid = r2(m.mid);
    m.hist.push(m.mid);
    if (m.hist.length > 30) m.hist.shift();
    // прогноз на завтра (виден с Каримом)
    m.next = r2(clamp(m.mid + (MID_BASE - m.mid) * 0.15 + gauss(s) * 0.7, 84, 101));
  }

  // ---------- Люди ----------
  function person(s, gender) {
    const g = gender || (rnd(s) < 0.5 ? 'm' : 'f');
    return { g, first: pick(s, D.names[g]), patr: pick(s, D.names['p' + g]), init: pick(s, D.names.init) };
  }
  const short = p => `${p.first} ${p.init}.`;
  const full = p => `${p.first} ${p.patr} ${p.init}.`;
  function otherPerson(s, p) {
    // поздние главы — тонкие подмены (другая первая буква фамилии)
    if (s.chapter >= 4 && rnd(s) < 0.5) {
      let init; do { init = pick(s, D.names.init); } while (init === p.init);
      return Object.assign({}, p, { patr: pick(s, D.names['p' + p.g]), init });
    }
    let q; do { q = person(s); } while (q.first === p.first);
    return q;
  }

  // ---------- Ордера ----------
  function orderCount(s) {
    let n = 8;
    if (has(s, 'flat')) n++;
    if (hired(s, 'pasha')) n++;
    if (hired(s, 'ivan')) n += 2;
    if (has(s, 'lux')) n++;
    if (s.rep >= 75) n++;
    return n;
  }

  function marginBonus(s) {
    let b = 0;
    if (hired(s, 'karim')) b += 0.005;
    if (s.flags.maxWar && !s.flags.ip && s.rep < 70) b -= 0.006;
    else if (s.flags.maxWar && s.rep < 70) b -= 0.003;
    for (const x of s.buffs) b += x.delta;
    return b;
  }

  function niceQty(q) {
    if (q < 100) return Math.max(5, Math.round(q));
    if (q < 1000) return Math.round(q / 5) * 5;
    if (q < 10000) return Math.round(q / 10) * 10;
    return Math.round(q / 50) * 50;
  }

  function makeOrder(s) {
    const mid = s.market.mid;
    const nw = Math.max(netWorth(s), 1000);
    const side = rnd(s) < 0.5 ? 'sell' : 'buy'; // sell: клиент покупает у тебя USDT
    let fp = [0, 0, 0.16, 0.2, 0.24, 0.26, 0.28, 0.28, 0.28][s.chapter];
    if (s.flags.ip) fp *= 0.4;
    fp *= 1.25 - s.rep / 200;
    const fraud = rnd(s) < fp ? (side === 'sell' ? pick(s, ['third', 'fake', 'under']) : 'drop') : null;
    let m = 0.035 + rnd(s) * 0.03 + marginBonus(s);
    if (fraud && rnd(s) < 0.55) m += 0.012 + rnd(s) * 0.025; // «слишком хорошая» цена
    m = Math.max(0.003, m);
    const vip = hired(s, 'ivan') && rnd(s) < 0.3;
    // мошенники чаще «пробуют» суммами поменьше
    const frac = vip ? 0.75 + rnd(s) * 0.25 : fraud ? 0.2 + rnd(s) * 0.35 : 0.3 + rnd(s) * 0.7;
    const qty = niceQty(frac * nw * 0.95 / mid);
    const price = r2(side === 'sell' ? mid * (1 + m) : mid * (1 - m));
    const total = r2(qty * price);
    const client = person(s);
    const o = {
      id: s.nextId++, side, qty, price, total, fraud, vip,
      client: { name: short(client), rating: (fraud ? 4.3 + rnd(s) * 0.7 : 4.6 + rnd(s) * 0.4).toFixed(1), deals: fraud && rnd(s) < 0.5 ? Math.floor(rnd(s) * 12) : 20 + Math.floor(rnd(s) * 900) },
      note: null,
    };
    if (side === 'sell') {
      let amount = total;
      if (fraud === 'under') amount = r2(total * (1 - (0.02 + rnd(s) * 0.08)));
      o.pay = { from: fraud === 'third' ? full(otherPerson(s, client)) : full(client), amount, source: fraud === 'fake' ? 'screenshot' : 'bank', bank: pick(s, D.banks) };
    } else {
      o.card = { holder: fraud === 'drop' ? full(otherPerson(s, client)) : full(client), bank: pick(s, D.banks) };
    }
    const r = rnd(s);
    if (fraud === 'third' && r < 0.35) o.note = pick(s, D.notes.third);
    else if (fraud === 'drop' && r < 0.35) o.note = pick(s, D.notes.drop);
    else if (fraud && r < 0.75) o.note = pick(s, D.notes.pressure);
    else if (!fraud && r < 0.3) o.note = pick(s, rnd(s) < 0.4 ? D.notes.pressure : D.notes.legit);
    o.est = estimate(s, o);
    return o;
  }

  function tutorialOrder(s) {
    const mid = s.market.mid, qty = 74, price = r2(mid + 1);
    const p = person(s);
    const o = { id: s.nextId++, side: 'sell', qty, price, total: r2(qty * price), fraud: null, tutorial: true,
      client: { name: short(p), rating: '5.0', deals: 312 }, note: 'Саня сказал, ты новенький. Оплатил, проверяй 🙂' };
    o.pay = { from: full(p), amount: o.total, source: 'bank', bank: 'Т-Банк' };
    o.est = estimate(s, o);
    return o;
  }

  function genOrders(s) {
    s.orders = [];
    if (s.chapter < 2 || s.frozen > 0 || s.ending) return;
    const n = orderCount(s);
    for (let i = 0; i < n; i++) s.orders.push(makeOrder(s));
  }

  function sbpFee(s, total) {
    const over = Math.max(0, s.sbpUsed + total - sbpLimit(s)) - Math.max(0, s.sbpUsed - sbpLimit(s));
    return over > 0 ? Math.min(SBP_FEE_CAP, r2(over * SBP_FEE)) : 0;
  }

  // Ожидаемая прибыль и возможность исполнить (для карточки ордера).
  function estimate(s, o) {
    const mid = s.market.mid;
    if (o.side === 'sell') {
      const short = Math.max(0, o.qty - s.usdt);
      const conv = short * mid * EXCHANGE_FEE;
      const can = short === 0 || s.rub >= short * mid * (1 + EXCHANGE_FEE) - 1e-6;
      return { profit: r2((o.price - mid) * o.qty - conv), conv: r2(conv), fee: 0, can };
    }
    const fee = sbpFee(s, o.total);
    const need = o.total + fee;
    const shortRub = Math.max(0, need - s.rub);
    const sellQty = shortRub / (mid * (1 - EXCHANGE_FEE));
    const conv = sellQty * mid * EXCHANGE_FEE;
    const can = s.usdt >= sellQty - 1e-9;
    return { profit: r2((mid - o.price) * o.qty - fee - conv), conv: r2(conv), fee, can };
  }
  function refreshEstimates(s) { for (const o of s.orders) o.est = estimate(s, o); }

  // Рубли ушли в минус, а USDT есть — продаём монеты на бирже, чтобы закрыть дыру.
  function settle(s) {
    if (s.rub >= 0 || s.usdt <= 0) return;
    const mid = s.market.mid;
    const q = Math.min(s.usdt, -s.rub / (mid * (1 - EXCHANGE_FEE)));
    s.usdt -= q; s.rub += q * mid * (1 - EXCHANGE_FEE); s.fees += q * mid * EXCHANGE_FEE;
    if (s.usdt < 1e-9) s.usdt = 0;
  }

  function addRisk(s, base) { s.risk = clamp(s.risk + base * riskMult(s), 0, 100); }

  function bookProfit(s, p) {
    s.profit += p; s.today.profit += p;
    if (p > 0 && taxActive(s)) {
      const tax = p * taxRate(s);
      if (s.taxOn || hired(s, 'grisha')) { s.rub -= tax; s.taxReserve += tax; }
      else s.taxDebt += tax;
    }
  }

  function acceptOrder(s, id) {
    if (s.ending) return fail('Игра окончена');
    const o = s.orders.find(x => x.id === id);
    if (!o) return fail('Ордер уже закрыт');
    const cost = orderEnergy(s);
    if (s.energy < cost) return fail('Нет сил. Заверши день 🌙');
    const e = estimate(s, o);
    if (!e.can) return fail('Не хватает капитала на этот ордер');
    const mid = s.market.mid;
    const nw0 = netWorth(s);
    if (o.side === 'sell') {
      const short = Math.max(0, o.qty - s.usdt);
      if (short > 0) { s.rub -= short * mid * (1 + EXCHANGE_FEE); s.usdt += short; s.fees += short * mid * EXCHANGE_FEE; }
      s.usdt -= o.qty; s.rub += o.total;
    } else {
      const fee = sbpFee(s, o.total);
      const need = o.total + fee;
      if (s.rub < need) {
        const q = (need - s.rub) / (mid * (1 - EXCHANGE_FEE));
        s.usdt -= q; s.rub += q * mid * (1 - EXCHANGE_FEE); s.fees += q * mid * EXCHANGE_FEE;
      }
      s.rub -= need; s.usdt += o.qty; s.fees += fee; s.sbpUsed += o.total;
    }
    if (s.usdt < 1e-9) s.usdt = 0;
    s.orders = s.orders.filter(x => x !== o);
    s.energy -= cost;
    s.stress = clamp(s.stress + ORDER_STRESS, 0, 100);
    s.turnover += o.total; s.today.turnover += o.total; s.today.orders++;
    s.stats.ordersDone++;
    addRisk(s, 2 + 4 * Math.min(1.5, o.total / Math.max(nw0, 1)));
    let msg = o.side === 'sell' ? `Отпустил ${fmt(o.qty)} USDT` : `Оплатил и получил ${fmt(o.qty)} USDT`;
    const fx = { kind: 'deal', profit: 0 };
    // Толстый палец при высоком стрессе
    if (s.stress >= 70 && !o.tutorial && rnd(s) < 0.15) {
      const loss = r2(o.total * 0.02);
      s.rub -= loss; s.stats.lost += loss;
      fx.fat = loss; msg += ` · 🫠 Толстый палец: −${fmt(loss)} ₽`;
    }
    const p = netWorth(s) - nw0 + (fx.fat || 0);
    bookProfit(s, p);
    fx.profit = r2(p);
    if (o.fraud) s.pendingFraud.push({ id: o.id, side: o.side, fraud: o.fraud, qty: o.qty, total: o.total, amount: o.pay ? o.pay.amount : 0, client: o.client.name });
    else if (o.tutorial) { s.flags.firstProfit = true; msg = 'Первая чистая прибыль: +74 ₽. Немного — но заработано головой.'; }
    refreshEstimates(s);
    checkChapter(s);
    return ok(msg, fx);
  }

  function disputeOrder(s, id) {
    if (s.ending) return fail('Игра окончена');
    const o = s.orders.find(x => x.id === id);
    if (!o) return fail('Ордер уже закрыт');
    if (s.energy < DISPUTE_ENERGY) return fail('Нет сил. Заверши день 🌙');
    s.energy -= DISPUTE_ENERGY;
    s.orders = s.orders.filter(x => x !== o);
    if (o.fraud) {
      s.rep = clamp(s.rep + 2, 0, 100);
      s.trust.pasha = clamp(s.trust.pasha + 1, 0, 100);
      s.stats.caught++;
      return ok(`Мошенник пойман! ${fraudText(o.fraud)}`, { kind: 'caught' });
    }
    s.rep = clamp(s.rep - 2, 0, 100);
    s.stats.wrongDisputes++;
    s.stress = clamp(s.stress + 2, 0, 100);
    return ok('Клиент был честным. Ушёл с отзывом 👎', { kind: 'wrong' });
  }

  function fraudText(f) {
    return {
      third: 'Платёж от третьего лица — ворованные деньги.',
      fake: 'Денег в банке нет — только поддельный чек.',
      under: 'Недоплата: сумма не сходится.',
      drop: 'Карта на чужое имя — схема дропперов.',
    }[f];
  }

  // ---------- Подработки ----------
  function rollHustles(s) {
    if (s.chapter === 1) {
      const pool = Object.keys(D.hustles).filter(id => id !== 'consult' && !(D.hustles[id].once && s.flags['h_' + id]));
      const out = [];
      while (out.length < Math.min(4, pool.length)) { const id = pick(s, pool); if (!out.includes(id)) out.push(id); }
      s.hustles = out;
    } else s.hustles = s.frozen > 0 ? ['consult'] : [];
  }

  function doHustle(s, id) {
    if (s.ending) return fail('Игра окончена');
    if (!s.hustles.includes(id)) return fail('Подработка недоступна');
    const h = D.hustles[id];
    if (s.energy < h.energy) return fail('Нет сил. Заверши день 🌙');
    s.energy -= h.energy;
    s.stress = clamp(s.stress + h.stress, 0, 100);
    s.hustles = s.hustles.filter(x => x !== id);
    if (h.once) s.flags['h_' + id] = true;
    if (h.trust) for (const k in h.trust) s.trust[k] = clamp(s.trust[k] + h.trust[k], 0, 100);
    let gain = h.rub || 0;
    if (h.nwPct) gain = Math.max(h.minRub, Math.round(netWorth(s) * h.nwPct));
    let msg;
    if (h.bet) {
      if (s.rub < h.bet) return fail('Не хватает денег на ставку'); // act() откатит списанную энергию
      if (rnd(s) < 0.4) { gain = h.bet; msg = 'Даня вырубил соперника! +1 500 ₽'; }
      else { gain = -h.bet; s.stress = clamp(s.stress + 10, 0, 100); msg = 'Даня проиграл по очкам. −1 500 ₽. Не ставь последнее.'; }
    } else msg = `${h.name}: +${fmt(gain)} ₽`;
    s.rub += gain;
    s.today.profit += gain;
    refreshEstimates(s);
    checkChapter(s);
    return ok(msg, { kind: gain >= 0 ? 'money' : 'loss', profit: gain });
  }

  // ---------- Магазин и команда ----------
  function buyUpgrade(s, id) {
    const u = D.upgrades[id];
    if (!u) return fail('Нет такого апгрейда');
    if (s.upgrades[id]) return fail('Уже куплено');
    if (s.chapter < u.minCh) return fail(`Откроется в главе ${u.minCh}`);
    if (s.rub < u.price) return fail('Не хватает рублей');
    s.rub -= u.price;
    s.upgrades[id] = s.day;
    if (id === 'lux') { s.trust.ivan = clamp(s.trust.ivan + 20, 0, 100); s.trust.marat = clamp(s.trust.marat - 15, 0, 100); s.trust.karim = clamp(s.trust.karim - 15, 0, 100); s.rep = clamp(s.rep + 5, 0, 100); }
    if (id === 'ip') { s.flags.ip = true; s.trust.grisha = clamp(s.trust.grisha + 5, 0, 100); s.trust.marat = clamp(s.trust.marat + 5, 0, 100); }
    refreshEstimates(s);
    checkChapter(s);
    return ok(`${u.icon} ${u.name} — куплено`, { kind: 'buy' });
  }

  function hire(s, id) {
    const c = D.characters[id];
    if (!D.hireable.includes(id)) return fail('Этого человека нельзя нанять');
    if (s.chapter < 5) return fail('Команда собирается в главе 5');
    if (hired(s, id)) return fail('Уже в команде');
    if (s.trust[id] < 40) return fail(`${c.name} тебе не доверяет (нужно доверие 40+)`);
    s.team.push(id);
    s.trust[id] = clamp(s.trust[id] + 5, 0, 100);
    if (id === 'danya') s.energy += 20;
    s.chat.push({ from: id, text: hireLine(id) });
    checkChapter(s);
    return ok(`${c.avatar} ${c.name} в команде`, { kind: 'buy' });
  }
  function hireLine(id) {
    return {
      pasha: 'Я в деле. Ни один кидала мимо меня не пройдёт.',
      karim: 'Договорились. Буду считать каждую копейку — и тебя заставлю.',
      grisha: 'Хорошо. Но работаем только по-белому, с документами на каждую сделку.',
      danya: 'Наконец-то! Я тебя прикрою, братан 🥊',
      kapul: 'Отлично. У меня есть пара людей, которым нужен объём 😉',
      ivan: 'Наконец-то серьёзный уровень! Клиенты пойдут, отвечаю ⌚',
    }[id];
  }

  function retail(s) {
    if (s.retailDay === s.day) return fail('Сегодня уже ходил по магазинам');
    const cost = Math.max(500, Math.round(netWorth(s) * 0.004));
    if (s.rub < cost) return fail('Не хватает рублей');
    s.rub -= cost; s.retailDay = s.day;
    s.risk = clamp(s.risk - 10, 0, 100);
    s.stress = clamp(s.stress - 5, 0, 100);
    refreshEstimates(s);
    checkChapter(s);
    return ok(`Обычные покупки по карте: −${fmt(cost)} ₽, банк-риск −10`, { kind: 'buy' });
  }

  function toggleTax(s) {
    if (!taxActive(s)) return fail('Налоги появятся в главе 4');
    s.taxOn = !s.taxOn;
    return ok(s.taxOn ? 'Налоговая копилка включена' : 'Налоговая копилка выключена', {});
  }

  // ---------- События ----------
  const evById = id => D.events.find(e => e.id === id);

  function startEvent(s, id) {
    const ev = evById(id);
    const d = ev.init ? ev.init(s, () => rnd(s)) : {};
    const pre = typeof ev.pre === 'function' ? ev.pre(s, d) : ev.pre;
    for (const m of pre) s.chat.push({ from: m.from, text: m.text });
    s.pending.push({ key: s.nextId++, id, d, from: ev.from });
    s.doneEvents[id] = (s.doneEvents[id] || 0) + 1;
    trimChat(s);
  }
  function trimChat(s) { if (s.chat.length > 150) s.chat.splice(0, s.chat.length - 150); }

  function eventOptions(s, inst) {
    const ev = evById(inst.id);
    return ev.options.map((o, i) => ({ i, text: o.text }));
  }

  function choose(s, key, idx) {
    const inst = s.pending.find(p => p.key === key);
    if (!inst) return fail('Этот вопрос уже решён');
    const ev = evById(inst.id);
    const opt = ev.options[idx];
    if (!opt) return fail('Нет такого варианта');
    s.pending = s.pending.filter(p => p !== inst);
    s.chat.push({ from: 'hero', text: opt.text.replace(/^[^\p{L}\d]+/u, '') });
    const eff = typeof opt.eff === 'function' ? opt.eff(s, inst.d) : opt.eff;
    const res = applyEffects(s, eff || {}, inst.from);
    settle(s);
    if (opt.say) say(s, inst.from, opt.say);
    if (s.flags.tutorial && !s.flags.tutorialDone) {
      s.flags.tutorialDone = true;
      s.orders.unshift(tutorialOrder(s));
    }
    refreshEstimates(s);
    trimChat(s);
    if (!s.ending) checkChapter(s);
    return ok(res.msg || '', res.fx || {});
  }

  function applyEffects(s, e, from) {
    const out = { msg: '', fx: {} };
    const nw = netWorth(s);
    if (e.chance) {
      const branch = rnd(s) < e.chance.p ? e.chance.win : e.chance.lose;
      const r = applyEffects(s, branch, from);
      out.fx = r.fx;
    }
    if (e.nwPct) {
      const d = Math.round(Math.max(nw, 0) * e.nwPct);
      s.rub += d; s.today.profit += d;
      if (d < 0) s.stats.lost += -d;
      out.fx = { kind: d >= 0 ? 'money' : 'loss', profit: d };
    }
    if (e.rub) { s.rub += e.rub; s.today.profit += e.rub; }
    if (e.buyUsdt) { const c = r2(e.buyUsdt * s.market.mid); s.rub -= c; s.usdt += e.buyUsdt; }
    if (e.energy) s.energy = clamp(s.energy + e.energy, 0, maxEnergy(s));
    if (e.stress) s.stress = clamp(s.stress + e.stress, 0, 100);
    if (e.risk) s.risk = clamp(s.risk + e.risk, 0, 100);
    if (e.rep) s.rep = clamp(s.rep + e.rep, 0, 100);
    if (e.trust) for (const k in e.trust) s.trust[k] = clamp(s.trust[k] + e.trust[k], 0, 100);
    if (e.flag) s.flags[e.flag] = true;
    if (e.taxOn) s.taxOn = true;
    if (e.compliance) s.flags.complianceOk = true;
    if (e.freeze) { s.frozen = Math.max(s.frozen, e.freeze); s.orders = []; s.hustles = ['consult']; }
    if (e.marginBuff) s.buffs.push({ days: e.marginBuff.days, delta: e.marginBuff.delta });
    if (e.stat) s.stats[e.stat]++;
    if (e.payTax) {
      const pen = hired(s, 'grisha') ? 1 : 1.2;
      const due = r2(s.taxDebt * pen);
      s.rub -= due; s.taxPaid += due + s.taxReserve; s.taxReserve = 0; s.taxDebt = 0;
      if (due > 0) { s.chat.push({ from: 'grisha', text: `Списано ${fmt(due)} ₽${pen > 1 ? ' (с пенями и штрафом)' : ''}. Теперь чисто.` }); s.stats.lost += due * (pen - 1); }
      else s.chat.push({ from: 'grisha', text: 'Резерв ушёл в бюджет. Долгов нет 👌' });
    }
    if (e.say) say(s, from, e.say);
    if (e.ending) finish(s, e.ending);
    return out;
  }

  // «Гриша: текст» — реплика от Гриши, а не от автора события.
  function say(s, from, text) {
    const m = /^([А-ЯЁ][а-яё]+): (.+)$/su.exec(text);
    if (m) {
      const id = Object.keys(D.characters).find(k => D.characters[k].name.split(' ')[0] === m[1]);
      if (id) { s.chat.push({ from: id, text: m[2] }); return; }
    }
    s.chat.push({ from, text });
  }

  function rollMorningEvents(s) {
    // принудительные триггеры
    for (const ev of D.events) {
      if (!ev.trigger) continue;
      if (ev.once && s.doneEvents[ev.id]) continue;
      if (s.pending.some(p => p.id === ev.id)) continue;
      if (ev.trigger(s)) { startEvent(s, ev.id); return; }
    }
    if (s.pending.length) return;
    if (rnd(s) > 0.45) return;
    const pool = D.events.filter(ev => !ev.story && !ev.trigger && s.chapter >= ev.minCh && s.chapter <= ev.maxCh
      && !(ev.once && s.doneEvents[ev.id]) && (!ev.cond || ev.cond(s)));
    if (!pool.length) return;
    const w = ev => (ev.weight || 1) * (ev.kapulBoost && hired(s, 'kapul') ? 3 : 1);
    let total = pool.reduce((a, ev) => a + w(ev), 0), r = rnd(s) * total;
    for (const ev of pool) { r -= w(ev); if (r <= 0) { startEvent(s, ev.id); return; } }
  }

  // ---------- Главы ----------
  function checkChapter(s) {
    if (s.ending || s.chapter >= 8) return;
    if (s.pending.some(p => evById(p.id).story)) return; // сначала ответь на сюжетный вопрос
    const g = goal(s);
    if (!g.done) return;
    s.chapter++;
    s.chapterDay = s.day;
    s.energy = Math.max(s.energy, maxEnergy(s)); // новая глава — второе дыхание
    s.flash = { type: 'chapter', ch: s.chapter };
    const story = D.events.find(e => e.story === s.chapter);
    if (story) startEvent(s, story.id);
    if (s.chapter === 2) { s.hustles = []; genOrders(s); }
    else if (s.orders.length === 0 && s.frozen === 0) genOrders(s);
    refreshEstimates(s);
  }

  function finish(s, id) {
    const e = D.endings[id];
    s.ending = { id, title: e.title, icon: e.icon, text: e.text, good: e.good, day: s.day, nw: Math.round(netWorth(s)) };
    s.orders = []; s.pending = [];
  }

  // ---------- Конец дня ----------
  function endDay(s) {
    if (s.ending) return fail('Игра окончена');
    if (s.pending.length) return fail('Сначала ответь в чате 💬');
    const rep = { day: s.day, lines: [], profit: s.today.profit, turnover: s.today.turnover, orders: s.today.orders };

    for (const f of s.pendingFraud) {
      let loss = 0;
      if (f.fraud === 'third') { loss = f.total; s.risk = clamp(s.risk + 30, 0, 100); s.rep = clamp(s.rep - 3, 0, 100); }
      else if (f.fraud === 'fake') { loss = f.total; s.rep = clamp(s.rep - 1, 0, 100); }
      else if (f.fraud === 'under') { loss = r2(f.total - f.amount); }
      else if (f.fraud === 'drop') {
        s.risk = clamp(s.risk + 35, 0, 100); s.rep = clamp(s.rep - 2, 0, 100);
        if (rnd(s) < 0.5) loss = r2(f.qty * s.market.mid);
      }
      if (loss) { s.rub -= loss; s.stats.lost += loss; }
      s.stats.scammed++;
      rep.lines.push({ bad: true, text: `Ордер #${f.id} (${f.client}): ${fraudText(f.fraud)}${loss ? ` −${fmt(loss)} ₽` : ''}${f.fraud === 'third' || f.fraud === 'drop' ? ', банк-риск ↑' : ''}` });
    }
    s.pendingFraud = [];

    const cost = dailyCost(s);
    s.rub -= cost;
    rep.lines.push({ text: `Жизнь и аренда: −${fmt(cost)} ₽` });
    const share = r2(Math.max(0, s.today.profit) * teamShare(s));
    if (share > 0) {
      s.rub -= share;
      rep.lines.push({ text: `Доли команды (${Math.round(teamShare(s) * 100)}% прибыли): −${fmt(share)} ₽` });
    }
    settle(s);
    rep.nw = netWorth(s);
    rep.delta = r2(rep.nw - s.today.nw0);

    // Банк-риск (раздел 6.4 GDD)
    const wasFrozen = s.frozen > 0;
    if (s.frozen > 0) { s.frozen--; s.stats.frozenDays++; }
    s.risk = clamp(s.risk - (20 + (hired(s, 'grisha') ? 12 : 0) + (wasFrozen ? 10 : 0)), 0, 100);
    if (!wasFrozen && s.chapter >= 2) {
      const g = hired(s, 'grisha');
      if (s.risk >= 88) {
        s.frozen = g ? 3 : 6; s.rep = clamp(s.rep - 8, 0, 100); s.stress = clamp(s.stress + 25, 0, 100); s.risk = 60;
        rep.lines.push({ bad: true, text: `⛔ Банк ограничил ДБО по 115-ФЗ. Счета заморожены на ${s.frozen} дн.` });
        s.chat.push({ from: 'bank', text: 'Операции ограничены. Выявлены признаки транзитных операций. Обратитесь в отделение с документами.' });
      } else if (s.risk >= 70) {
        s.frozen = g ? 1 : 4; s.stress = clamp(s.stress + 12, 0, 100); s.risk -= 15;
        rep.lines.push({ bad: true, text: `📄 Банк запросил документы. Операции приостановлены на ${s.frozen} дн.${g ? ' Гриша ускорил проверку.' : ''}` });
        s.chat.push({ from: 'bank', text: 'Просим предоставить документы, подтверждающие экономический смысл операций.' });
      } else if (s.risk >= 48 && rnd(s) < 0.25) {
        s.frozen = 1;
        rep.lines.push({ bad: true, text: '🧊 Антифрод: охлаждение счёта на 24 часа.' });
      }
    }

    for (const b of s.buffs) b.days--;
    s.buffs = s.buffs.filter(b => b.days > 0);

    s.day++;
    if ((s.day - 1) % 30 === 0) s.sbpUsed = 0;
    const me = maxEnergy(s);
    s.stress = clamp(s.stress - (22 + (has(s, 'flat') ? 15 : 0) + (s.flags.grownUp ? 5 : 0)), 0, 100);
    s.energy = Math.round(me - s.stress * 0.3);
    moveMarket(s);
    s.today = { profit: 0, turnover: 0, orders: 0, nw0: netWorth(s) };
    genOrders(s);
    rollHustles(s);

    const nw = netWorth(s);
    s.stats.peak = Math.max(s.stats.peak, nw);
    rep.mid = s.market.mid;
    s.report = rep;

    if (nw < 0 || (s.chapter >= 2 && nw < 1500 && s.usdt * s.market.mid < 500)) {
      finish(s, s.rep >= 45 && !s.flags.dropper ? 'restart' : 'crash');
      return ok('Капитал закончился', { kind: 'end' });
    }
    rollMorningEvents(s);
    checkChapter(s);
    return ok(`День ${s.day}`, { kind: 'day' });
  }

  // Закрывает по одному окну: сначала отчёт дня, потом заставку главы.
  function ack(s) { if (s.report) s.report = null; else s.flash = null; return ok(''); }

  // ---------- Общий диспетчер ----------
  function ok(msg, fx) { return { ok: true, msg, fx: fx || {} }; }
  function fail(msg) { return { ok: false, msg }; }

  const ACTIONS = { accept: (s, a) => acceptOrder(s, a.id), dispute: (s, a) => disputeOrder(s, a.id), hustle: (s, a) => doHustle(s, a.id),
    buy: (s, a) => buyUpgrade(s, a.id), hire: (s, a) => hire(s, a.id), choose: (s, a) => choose(s, a.key, a.idx),
    endDay: s => endDay(s), retail: s => retail(s), tax: s => toggleTax(s), ack: s => ack(s) };

  // Транзакционно: при ошибке состояние не меняется.
  function act(s, a) {
    const fn = ACTIONS[a.type];
    if (!fn) return { state: s, res: fail('Неизвестное действие') };
    const draft = JSON.parse(JSON.stringify(s));
    const res = fn(draft, a);
    return { state: res.ok ? draft : s, res };
  }

  function load(json) {
    try { const s = JSON.parse(json); return s && s.v === VERSION ? s : null; } catch (e) { return null; }
  }

  return { VERSION, newGame, act, load, netWorth, goal, dailyCost, teamShare, orderEnergy, maxEnergy, eventOptions, sbpLimit, taxRate, has, hired, fmt, data: D };
});
