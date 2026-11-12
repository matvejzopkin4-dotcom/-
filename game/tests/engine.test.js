// Тесты движка: node --test game/tests
const test = require('node:test');
const assert = require('node:assert');
const E = require('../engine.js');
const { play } = require('./sim.js');

const act = (s, a) => E.act(s, a);

function toChapter2(seed = 3) {
  let s = E.newGame(seed);
  s = act(s, { type: 'choose', key: s.pending[0].key, idx: 1 }).state;
  s.rub = 9990;
  s.hustles = ['courier'];
  s = act(s, { type: 'hustle', id: 'courier' }).state;
  return s;
}

test('старт: 3 700 ₽, глава 1, сюжетный вопрос и подработки', () => {
  const s = E.newGame(1);
  assert.strictEqual(s.rub, 3700);
  assert.strictEqual(s.chapter, 1);
  assert.strictEqual(s.pending.length, 1);
  assert.ok(s.hustles.length >= 3);
  assert.strictEqual(s.orders.length, 0);
});

test('нельзя завершить день, не ответив в чате; ошибка не меняет состояние', () => {
  const s = E.newGame(1);
  const { state, res } = act(s, { type: 'endDay' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(state, s);
});

test('подработка даёт деньги и тратит энергию', () => {
  let s = E.newGame(2);
  s.hustles = ['courier'];
  const { state, res } = act(s, { type: 'hustle', id: 'courier' });
  assert.ok(res.ok);
  assert.strictEqual(state.rub, 4700);
  assert.strictEqual(state.energy, 70);
});

test('10 000 ₽ открывают главу 2 и учебную сделку на +74 ₽', () => {
  let s = toChapter2();
  assert.strictEqual(s.chapter, 2);
  assert.ok(s.orders.length > 0);
  const p = s.pending.find(x => x.id === 'ch2_intro');
  s = act(s, { type: 'choose', key: p.key, idx: 0 }).state;
  assert.strictEqual(s.usdt, 74);
  const tut = s.orders[0];
  assert.ok(tut.tutorial);
  const before = E.netWorth(s);
  const { state, res } = act(s, { type: 'accept', id: tut.id });
  assert.ok(res.ok, res.msg);
  assert.ok(Math.abs(E.netWorth(state) - before - 74) < 0.01);
  assert.ok(Math.abs(res.fx.profit - 74) < 0.01);
});

test('мошенник: принятый ордер с третьим лицом откатывается ночью, спор с ним — ловит', () => {
  let s = toChapter2(5);
  s = act(s, { type: 'choose', key: s.pending[0].key, idx: 0 }).state;
  s.orders = s.orders.filter(o => !o.tutorial);
  const o = s.orders[0];
  o.side = 'sell'; o.fraud = 'third'; o.qty = 50; o.price = Math.round(s.market.mid * 103) / 100; o.total = o.qty * o.price;
  o.pay = { from: 'Олег Петрович Ж.', amount: o.total, source: 'bank', bank: 'Сбер' };
  s.usdt = o.qty; s.rub = 9000; // ниже цели главы 2, чтобы не открылась глава 3
  const nw0 = E.netWorth(s), risk0 = s.risk;
  s = act(s, { type: 'accept', id: o.id }).state;
  assert.ok(E.netWorth(s) > nw0);
  s = act(s, { type: 'endDay' }).state;
  assert.strictEqual(s.stats.scammed, 1);
  assert.ok(s.report.lines.some(l => l.bad && /третьего лица/.test(l.text)));
  assert.ok(s.risk > risk0 - 25);

  let t = toChapter2(6);
  t = act(t, { type: 'choose', key: t.pending[0].key, idx: 0 }).state;
  const f = t.orders.find(x => !x.tutorial);
  f.fraud = 'drop';
  const rep0 = t.rep;
  const r = act(t, { type: 'dispute', id: f.id });
  assert.strictEqual(r.res.fx.kind, 'caught');
  assert.strictEqual(r.state.rep, rep0 + 2);
});

test('высокий банк-риск ночью замораживает счета', () => {
  let s = toChapter2(7);
  s = act(s, { type: 'choose', key: s.pending[0].key, idx: 0 }).state;
  s.risk = 100;
  s = act(s, { type: 'endDay' }).state;
  assert.ok(s.frozen > 0);
  assert.strictEqual(s.orders.length, 0);
  assert.deepStrictEqual(s.hustles, ['consult']);
});

test('налоговый долг без копилки оплачивается со штрафом 20%', () => {
  let s = E.newGame(9);
  s.chapter = 6; s.flags.complianceOk = true; s.taxDebt = 1000; s.rub = 50000; s.pending = [];
  s = act(s, { type: 'ack' }).state;
  s.chat = [];
  // запускаем проверку через утренние события
  s = act(s, { type: 'endDay' }).state;
  const p = s.pending.find(x => x.id === 'tax_audit');
  assert.ok(p, 'налоговая сверка должна начаться');
  const rub0 = s.rub;
  s = act(s, { type: 'choose', key: p.key, idx: 0 }).state;
  assert.strictEqual(s.taxDebt, 0);
  assert.ok(Math.abs(rub0 - s.rub - 1200) < 0.01);
});

test('финал: Карим + Гриша + доверие → «Архитектор», плечо без комплаенса → «Империя на песке»', () => {
  const base = () => {
    const s = E.newGame(11);
    s.pending = []; s.chapter = 7; s.flags.ip = true; s.flags.complianceOk = true;
    s.team = ['grisha', 'karim', 'pasha']; s.rub = 3e6;
    return s;
  };
  let s = act(base(), { type: 'ack' }).state; // ack вызывает только сброс, глава проверяется действием
  s = act(s, { type: 'retail' }).state;
  assert.strictEqual(s.chapter, 8);
  const council = s.pending.find(p => p.id === 'ch8_council');
  s.trust.marat = 70; s.trust.karim = 70; s.trust.pasha = 70;
  const good = act(s, { type: 'choose', key: council.key, idx: 1 }).state;
  assert.strictEqual(good.ending.id, 'architect');
  s.team = ['karim'];
  const bad = act(s, { type: 'choose', key: council.key, idx: 0 }).state;
  assert.strictEqual(bad.ending.id, 'crash');
});

test('сохранение: состояние переживает JSON и загрузку', () => {
  const s = toChapter2(4);
  const loaded = E.load(JSON.stringify(s));
  assert.deepStrictEqual(loaded, JSON.parse(JSON.stringify(s)));
  assert.strictEqual(E.load('{"v":999}'), null);
  assert.strictEqual(E.load('мусор'), null);
});

test('бот проходит игру до финала за разумное число дней', () => {
  const days = [];
  for (let seed = 1; seed <= 12; seed++) {
    const s = play(seed);
    assert.ok(s.ending, `seed ${seed}: нет финала (глава ${s.chapter}, день ${s.day})`);
    days.push(s.day);
  }
  days.sort((a, b) => a - b);
  const median = days[6];
  assert.ok(median >= 20 && median <= 60, 'медиана дней: ' + median + ' ' + days);
});
