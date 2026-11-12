// Бот, проходящий игру. Используется тестами и для балансировки:
//   node game/tests/sim.js [число прогонов]
const E = require('../engine.js');

// Предпочтения бота в событиях: индекс варианта (по умолчанию — «честный» путь).
const PICK = { ch1_intro: 1, danya_coin: 1, mom_call: 0, sanya_drop: 1, lera_back: 1, rumor_sbp: 0, marat_hello: 0,
  max_rival: 1, fatigue: 0, ch4_intro: 0, karim_spread: 1, pasha_cash: 0, ivan_watch: 0, conflict_leverage: 0,
  otc: 1, ch6_intro: 0, tax_audit: 0, max_fake_reviews: 1, ch7_intro: 0, ch8_council: 1 };

function play(seed, opts = {}) {
  const baseSkill = opts.skill == null ? 0.85 : opts.skill; // шанс распознать мошенника без подсказок
  // апгрейды подсвечивают подвох — как и для живого игрока
  const skillFor = (s, o) => {
    const nameHint = s.upgrades.pc || s.team.includes('pasha');
    const payHint = s.upgrades.receipt;
    if ((o.fraud === 'third' || o.fraud === 'drop') && nameHint) return 0.99;
    if ((o.fraud === 'fake' || o.fraud === 'under') && payHint) return 0.99;
    return baseSkill;
  };
  const pick = Object.assign({}, PICK, opts.pick || {});
  let s = E.newGame(seed);
  let rngS = seed * 7 + 1;
  const r = () => { rngS = (rngS * 1103515245 + 12345) & 0x7fffffff; return rngS / 0x7fffffff; };
  const act = a => { const out = E.act(s, a); s = out.state; return out.res; };
  for (let guard = 0; guard < 400 && !s.ending; guard++) {
    if (s.report || s.flash) act({ type: 'ack' });
    while (s.pending.length) {
      const p = s.pending[0];
      act({ type: 'choose', key: p.key, idx: pick[p.id] || 0 });
    }
    if (s.ending) break;
    // покупки и найм
    for (const id of ['receipt', 'pc', 'bank2', 'flat', 'ip']) {
      const u = E.data.upgrades[id];
      if (!s.upgrades[id] && s.chapter >= u.minCh && s.rub > u.price * (id === 'receipt' ? 1.5 : 2.5)) act({ type: 'buy', id });
    }
    if (s.chapter >= 5) for (const id of ['pasha', 'karim', 'grisha']) if (!s.team.includes(id)) act({ type: 'hire', id });
    if (s.risk >= 40) act({ type: 'retail' });
    // подработки
    for (const id of s.hustles.slice()) if (id !== 'bet') act({ type: 'hustle', id });
    // ордера
    for (const o of s.orders.slice()) {
      if (s.energy < E.orderEnergy(s)) break;
      if (s.risk >= 62) break;
      const spot = o.fraud ? r() < skillFor(s, o) : r() < 0.04;
      if (spot) act({ type: 'dispute', id: o.id });
      else if (o.est.can && o.est.profit > 0) act({ type: 'accept', id: o.id });
    }
    while (s.pending.length) act({ type: 'choose', key: s.pending[0].key, idx: pick[s.pending[0].id] || 0 });
    if (s.ending) break;
    const res = act({ type: 'endDay' });
    if (!res.ok) throw new Error('endDay failed: ' + res.msg);
  }
  return s;
}

module.exports = { play };

if (require.main === module) {
  const n = +process.argv[2] || 20;
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const s = play(i);
    rows.push({ seed: i, ending: s.ending && s.ending.id, day: s.day, nw: Math.round(E.netWorth(s)), ch: s.chapter, caught: s.stats.caught, scammed: s.stats.scammed, frozen: s.stats.frozenDays });
  }
  console.table(rows);
  const days = rows.map(r => r.day).sort((a, b) => a - b);
  console.log('median days', days[Math.floor(n / 2)], 'min', days[0], 'max', days[n - 1]);
}
