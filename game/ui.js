/* «P2P: С нуля» — интерфейс. Рендерит состояние движка, анимации, звук, сохранения. */
(function () {
  'use strict';
  const E = window.P2PEngine, D = window.P2PData;
  const SAVE = 'p2p-zero-save-v1', SOUND = 'p2p-zero-sound';
  const $ = id => document.getElementById(id);
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rub = v => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
  const rub2 = v => `${(Math.round(v * 100) / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
  const usdt = v => `${(Math.round(v * 100) / 100).toLocaleString('ru-RU')} USDT`;
  const signed = v => (v >= 0 ? '+' : '−') + rub(Math.abs(v));

  let S = null;              // текущее состояние
  let shownNw = 0;           // для анимации капитала
  let chatSeen = 0;          // сколько сообщений уже анимировано
  let tab = 'board';
  let sound = localStorage.getItem(SOUND) !== 'off';

  // ---------- Звук (WebAudio, без файлов) ----------
  let ac = null;
  function tone(freq, dur, type = 'sine', vol = 0.06, delay = 0) {
    if (!sound) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur);
    } catch (e) { /* звук не критичен */ }
  }
  const sfx = {
    coin: () => { tone(880, 0.08, 'triangle'); tone(1320, 0.12, 'triangle', 0.05, 0.07); },
    caught: () => { tone(520, 0.08, 'square', 0.04); tone(780, 0.14, 'square', 0.04, 0.08); },
    bad: () => { tone(160, 0.25, 'sawtooth', 0.05); tone(110, 0.3, 'sawtooth', 0.04, 0.1); },
    click: () => tone(600, 0.04, 'triangle', 0.03),
    msg: () => tone(990, 0.06, 'sine', 0.03),
    day: () => { tone(330, 0.2, 'sine', 0.04); tone(247, 0.3, 'sine', 0.04, 0.15); },
    level: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, 'triangle', 0.05, i * 0.1)),
  };

  // ---------- Состояние / сохранение ----------
  function save() { try { localStorage.setItem(SAVE, JSON.stringify(S)); } catch (e) { /* приватный режим */ } }
  function loadSave() { const raw = localStorage.getItem(SAVE); return raw ? E.load(raw) : null; }

  function act(a) {
    const { state, res } = E.act(S, a);
    if (!res.ok) { toast(res.msg, 'bad'); sfx.click(); return res; }
    S = state;
    save();
    feedback(a, res);
    render();
    return res;
  }

  function feedback(a, res) {
    const fx = res.fx || {};
    if (a.type === 'accept') {
      if (fx.fat) { sfx.bad(); shake(); }
      else sfx.coin();
      floatNum(fx.profit);
      toast(res.msg, fx.fat ? 'bad' : 'good');
    } else if (a.type === 'dispute') {
      if (fx.kind === 'caught') { sfx.caught(); toast('🛡️ ' + res.msg, 'good'); }
      else { sfx.bad(); toast(res.msg, 'bad'); }
    } else if (a.type === 'hustle') {
      if (fx.kind === 'loss') { sfx.bad(); shake(); } else sfx.coin();
      floatNum(fx.profit);
      toast(res.msg, fx.kind === 'loss' ? 'bad' : 'good');
    } else if (a.type === 'choose') {
      sfx.click();
      if (fx.profit) { floatNum(fx.profit); fx.profit < 0 ? (sfx.bad(), shake()) : sfx.coin(); }
    } else if (a.type === 'endDay') {
      sfx.day();
    } else if (res.msg && a.type !== 'ack') {
      sfx.click(); toast(res.msg);
    }
  }

  // ---------- Эффекты ----------
  function toast(text, kind = '') {
    if (!text) return;
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3100);
  }
  function floatNum(v) {
    if (!v) return;
    const anchor = document.querySelector('.stat.nw');
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'float ' + (v >= 0 ? 'up' : 'down');
    el.textContent = signed(v);
    el.style.left = (r.left + r.width / 2) + 'px';
    el.style.top = (r.top + r.height / 2) + 'px';
    $('fx').appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }
  function shake() { document.body.classList.remove('shake'); void document.body.offsetWidth; document.body.classList.add('shake'); }
  function confetti() {
    const em = ['💸', '✨', '💎', '🟢', '📈', '🎉'];
    for (let i = 0; i < 36; i++) {
      const el = document.createElement('div');
      el.className = 'confetti';
      el.textContent = em[i % em.length];
      el.style.left = Math.random() * 100 + 'vw';
      el.style.animationDelay = Math.random() * 0.6 + 's';
      el.style.animationDuration = 1.6 + Math.random() * 1.4 + 's';
      $('fx').appendChild(el);
      setTimeout(() => el.remove(), 3800);
    }
  }
  function tweenNw(target) {
    const el = $('nw-val');
    if (!el) return;
    const from = shownNw, t0 = performance.now(), dur = 600;
    if (Math.abs(target - from) < 1) { el.textContent = rub(target); shownNw = target; return; }
    function step(t) {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      const v = from + (target - from) * e;
      const node = $('nw-val'); if (node) node.textContent = rub(v);
      if (k < 1) requestAnimationFrame(step); else shownNw = target;
    }
    requestAnimationFrame(step);
  }

  // ---------- Рендер ----------
  function render() {
    renderTop(); renderStats(); renderGoal(); renderBoard(); renderChat(); renderActions();
    if (S.ending) return showEnding();
    if (S.report) return showReport();
    if (S.flash && S.flash.type === 'chapter') return showChapter();
  }

  function renderTop() {
    const ch = D.chapters[S.chapter];
    $('where').innerHTML = `<span class="chip">Гл. ${S.chapter} · ${esc(ch.title)}</span><span class="day">День ${S.day}</span><span class="city">📍 ${esc(ch.city)}</span>`;
    $('btn-sound').textContent = sound ? '🔊' : '🔇';
  }

  function meter(label, val, cls, extra = '') {
    return `<div class="meter ${cls}"><div class="m-top"><span>${label}</span><b>${Math.round(val)}</b></div><div class="bar"><i style="width:${Math.max(0, Math.min(100, val))}%"></i>${extra}</div></div>`;
  }

  function spark(hist) {
    if (hist.length < 2) return '';
    const min = Math.min(...hist), max = Math.max(...hist), w = 90, h = 26;
    const pts = hist.map((v, i) => `${(i / (hist.length - 1) * w).toFixed(1)},${(h - (v - min) / (max - min || 1) * (h - 4) - 2).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
  }

  function renderStats() {
    const nw = E.netWorth(S), m = S.market, prev = m.hist[m.hist.length - 2] || m.mid;
    const up = m.mid >= prev;
    const riskCls = S.risk >= 88 ? 'crit' : S.risk >= 70 ? 'high' : S.risk >= 48 ? 'mid' : 'low';
    const forecast = E.hired(S, 'karim') ? `<small class="fc">завтра ≈ ${m.next.toFixed(2)} ${m.next >= m.mid ? '↗' : '↘'}</small>` : '';
    $('stats').innerHTML = `
      <div class="stat nw"><span class="lbl">Капитал</span><b id="nw-val">${rub(shownNw)}</b><small>${rub(S.rub)} · ${usdt(S.usdt)}</small></div>
      <div class="stat rate"><span class="lbl">USDT/RUB</span><b class="${up ? 'pos' : 'neg'}">${m.mid.toFixed(2)} ${up ? '▲' : '▼'}</b>${spark(m.hist)}${forecast}</div>
      <div class="meters">
        ${meter('⚡ Энергия', S.energy / E.maxEnergy(S) * 100, 'energy')}
        ${meter('😵 Стресс', S.stress, S.stress >= 70 ? 'stress hot' : 'stress')}
        ${meter('🏦 Банк-риск', S.risk, 'risk ' + riskCls, '<em style="left:48%"></em><em style="left:70%"></em><em style="left:88%"></em>')}
        ${meter('⭐ Репутация', S.rep, 'rep')}
      </div>`;
    tweenNw(nw);
  }

  function renderGoal() {
    const g = E.goal(S);
    const extra = (g.extra || []).map(x => `<span class="chip sm">${esc(x)}</span>`).join('');
    const tgt = g.target ? `<span class="muted">${rub(Math.max(0, g.nw))} / ${rub(g.target)}</span>` : '';
    $('goal').innerHTML = `<div class="g-row"><span>🎯 ${esc(g.text)}</span>${extra}${tgt}</div><div class="gbar"><i style="width:${(g.progress * 100).toFixed(1)}%"></i></div>`;
  }

  function nameHint(o) { return E.has(S, 'pc') || E.hired(S, 'pasha'); }
  function payHint() { return E.has(S, 'receipt'); }

  function orderCard(o) {
    const sell = o.side === 'sell';
    const pct = ((sell ? o.price / S.market.mid - 1 : 1 - o.price / S.market.mid) * 100).toFixed(1);
    const nh = nameHint(o), ph = payHint();
    const warnName = nh && (o.fraud === 'third' || o.fraud === 'drop');
    const okName = nh && !warnName;
    const rows = [];
    if (sell) {
      const under = o.pay.amount < o.total - 0.005, shot = o.pay.source === 'screenshot';
      rows.push(`<div class="row"><span>К оплате</span><b>${rub2(o.total)}</b></div>`);
      rows.push(`<div class="row ${ph && under ? 'warn' : ''}"><span>Пришло</span><b>${rub2(o.pay.amount)}${ph && under ? ' 🤖 недоплата' : ''}</b></div>`);
      rows.push(`<div class="row ${warnName ? 'warn' : okName ? 'okk' : ''}"><span>Отправитель</span><b>${esc(o.pay.from)}${warnName ? ' 🛡️ не клиент' : okName ? ' ✓' : ''}</b></div>`);
      rows.push(`<div class="row ${ph && shot ? 'warn' : ''}"><span>Подтверждение</span><b>${shot ? `🧾 скрин чека от клиента${ph ? ' 🤖 подделка' : ''}` : `🏦 зачисление в ${esc(o.pay.bank)}`}</b></div>`);
    } else {
      rows.push(`<div class="row"><span>Ты платишь</span><b>${rub2(o.total)}${o.est.fee ? ` <small>+ СБП ${rub(o.est.fee)}</small>` : ''}</b></div>`);
      rows.push(`<div class="row ${warnName ? 'warn' : okName ? 'okk' : ''}"><span>Карта продавца</span><b>${esc(o.card.bank)} · ${esc(o.card.holder)}${warnName ? ' 🛡️ не клиент' : okName ? ' ✓' : ''}</b></div>`);
    }
    const note = o.note ? `<div class="note">💬 «${esc(o.note)}»</div>` : '';
    const est = o.est;
    const conv = est.conv > 0 ? ` <small class="muted">(с докупкой на бирже)</small>` : '';
    return `<article class="order ${sell ? 'sell' : 'buy'} ${o.vip ? 'vip' : ''} ${o.tutorial ? 'tut' : ''}" data-id="${o.id}">
      <div class="o-head">
        <span class="tag">${sell ? 'КЛИЕНТ ПОКУПАЕТ' : 'КЛИЕНТ ПРОДАЁТ'}</span>${o.vip ? '<span class="tag vip">VIP</span>' : ''}
        <span class="o-sum"><b>${usdt(o.qty)}</b> по <b>${o.price.toFixed(2)}</b></span>
        <span class="o-pct">${pct > 0 ? '+' : ''}${pct}%</span>
      </div>
      <div class="o-client">👤 <b>${esc(o.client.name)}</b> <span class="muted">★${o.client.rating} · ${o.client.deals} сделок</span></div>
      <div class="o-rows">${rows.join('')}</div>
      ${note}
      <div class="o-foot">
        <span class="o-est ${est.profit >= 0 ? 'pos' : 'neg'}">≈ ${signed(est.profit)}${conv}</span>
        <div class="o-btns">
          <button class="btn danger" data-dispute="${o.id}">⚠️ Спор</button>
          <button class="btn go" data-accept="${o.id}" ${est.can ? '' : 'disabled'}>${est.can ? (sell ? '✅ Отпустить USDT' : '✅ Оплатить') : 'Мало капитала'}</button>
        </div>
      </div>
    </article>`;
  }

  function renderBoard() {
    const b = $('board');
    let html = '';
    if (S.chapter === 1 || S.frozen > 0) {
      if (S.frozen > 0) html += `<div class="banner bad">🧊 Счета заморожены ещё ${S.frozen} дн. Стакан недоступен — отдыхай, снижай риск, подрабатывай.</div>`;
      html += `<div class="panel-head"><span>${S.chapter === 1 ? '🧰 Подработки' : '🎓 Пока счета стоят'}</span><span class="muted">⚡ ${S.energy}</span></div>`;
      if (!S.hustles.length) html += `<div class="empty">На сегодня всё. Заверши день 🌙</div>`;
      html += '<div class="hustles">' + S.hustles.map(id => {
        const h = D.hustles[id];
        const gain = h.nwPct ? Math.max(h.minRub, Math.round(E.netWorth(S) * h.nwPct)) : h.rub;
        const label = h.bet ? '50/50 · риск 1 500 ₽' : `+${rub(gain)}`;
        return `<button class="hustle" data-hustle="${id}" ${S.energy < h.energy ? 'disabled' : ''}>
          <span class="h-ico">${h.icon}</span><span class="h-name">${esc(h.name)}</span>
          <span class="h-gain ${h.bet ? 'neg' : 'pos'}">${label}</span><span class="h-cost">⚡ −${h.energy}</span></button>`;
      }).join('') + '</div>';
    } else {
      html += `<div class="panel-head"><span>📈 Стакан · ордера дня</span><span class="muted">${S.orders.length} шт · ⚡ ${E.orderEnergy(S)} за сделку</span></div>`;
      html += `<div class="rules">Проверь: <b>ФИО отправителя = клиент</b> · <b>сумма до копейки</b> · <b>деньги видны в банке</b></div>`;
      if (!S.orders.length) html += `<div class="empty">Стакан пуст. ${S.today.orders ? `Сегодня закрыто сделок: ${S.today.orders}. ` : ''}Заверши день 🌙</div>`;
      html += S.orders.map(orderCard).join('');
    }
    b.innerHTML = html;
  }

  function avatar(from) { const c = D.characters[from]; return c ? c.avatar : '💬'; }

  function renderChat() {
    const feed = $('chat-feed');
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    if (S.chat.length < chatSeen) chatSeen = 0;
    feed.innerHTML = S.chat.map((m, i) => {
      const fresh = i >= chatSeen ? ' fresh' : '';
      if (m.from === 'sys') return `<div class="msg sys${fresh}">${esc(m.text)}</div>`;
      const c = D.characters[m.from] || { name: m.from };
      if (m.from === 'hero') return `<div class="msg me${fresh}"><div class="bubble">${esc(m.text)}</div></div>`;
      return `<div class="msg${fresh}"><span class="ava">${avatar(m.from)}</span><div class="bubble"><b class="who">${esc(c.name)}</b>${esc(m.text)}</div></div>`;
    }).join('');
    const fresh = S.chat.length - chatSeen;
    if (fresh > 0 && chatSeen > 0) sfx.msg();
    chatSeen = S.chat.length;
    if (atBottom || fresh > 0) feed.scrollTop = feed.scrollHeight;
    const opts = S.pending.map(p => {
      const c = D.characters[p.from] || { name: '' };
      return `<div class="opt-group"><div class="opt-who">Ответ: ${avatar(p.from)} ${esc(c.name)}</div>` +
        E.eventOptions(S, p).map(o => `<button class="opt" data-key="${p.key}" data-idx="${o.i}">${esc(o.text)}</button>`).join('') + '</div>';
    }).join('');
    $('chat-options').innerHTML = opts;
    $('chat-sub').textContent = S.pending.length ? `ждёт ответа: ${S.pending.length}` : 'онлайн';
    $('chat-dot').hidden = !S.pending.length;
    $('chat').classList.toggle('needs', S.pending.length > 0);
  }

  function renderActions() {
    const day = $('btn-day');
    const wait = S.pending.length > 0;
    day.innerHTML = wait ? '💬<span>Ответь в чате</span>' : '🌙<span>Завершить день</span>';
    day.classList.toggle('waiting', wait);
    $('btn-retail').disabled = S.retailDay === S.day || S.chapter < 2;
  }

  // ---------- Модалки ----------
  function modal(html, cls = '') {
    $('modal-card').className = 'modal-card ' + cls;
    $('modal-card').innerHTML = html;
    $('modal').hidden = false;
  }
  function closeModal() { $('modal').hidden = true; }

  function showReport() {
    const r = S.report;
    const lines = r.lines.map(l => `<li class="${l.bad ? 'bad' : ''}">${esc(l.text)}</li>`).join('');
    modal(`<div class="m-kicker">🌙 День ${r.day} закрыт</div>
      <div class="report-grid">
        <div><span>Сделок</span><b>${r.orders}</b></div>
        <div><span>Оборот</span><b>${rub(r.turnover)}</b></div>
        <div><span>Заработано</span><b class="${r.profit >= 0 ? 'pos' : 'neg'}">${signed(r.profit)}</b></div>
        <div><span>Итог дня</span><b class="${r.delta >= 0 ? 'pos' : 'neg'}">${signed(r.delta)}</b></div>
      </div>
      ${r.turnover > 0 && S.chapter >= 3 ? `<p class="lesson">Оборот ${rub(r.turnover)} — но в карман легло ${signed(r.delta)}. Оборот ≠ прибыль.</p>` : ''}
      <ul class="report-lines">${lines}</ul>
      <button class="big-btn" data-ack>☀️ Утро. Курс ${r.mid.toFixed(2)}</button>`, 'report');
    if (r.lines.some(l => l.bad)) { sfx.bad(); shake(); }
  }

  function showChapter() {
    const ch = D.chapters[S.flash.ch];
    modal(`<div class="m-kicker">Глава ${S.flash.ch} из 8</div><h2 class="ch-title">${esc(ch.title)}</h2>
      <p class="muted">📍 ${esc(ch.city)}</p><p class="ch-goal">🎯 ${esc(ch.goal)}</p>
      <button class="big-btn" data-ack>Поехали →</button>`, 'chapter');
    sfx.level(); confetti();
  }

  function showEnding() {
    const e = S.ending, st = S.stats;
    modal(`<div class="end-ico">${e.icon}</div><div class="m-kicker">Финал · день ${e.day}</div>
      <h2 class="ch-title">${esc(e.title)}</h2><p class="end-text">${esc(e.text)}</p>
      <div class="report-grid">
        <div><span>Капитал</span><b>${rub(e.nw)}</b></div>
        <div><span>Оборот за игру</span><b>${rub(S.turnover)}</b></div>
        <div><span>Мошенников поймано</span><b class="pos">${st.caught}</b></div>
        <div><span>Попался на скам</span><b class="neg">${st.scammed}</b></div>
      </div>
      <p class="muted center">Всего 4 финала. Попробуй другие решения.</p>
      <button class="big-btn" data-restart>↻ Новая игра</button>`, 'ending ' + (e.good ? 'good' : 'bad'));
    if (e.good) { sfx.level(); confetti(); } else sfx.bad();
  }

  function showShop() {
    const items = Object.keys(D.upgrades).map(id => {
      const u = D.upgrades[id], own = E.has(S, id), locked = S.chapter < u.minCh;
      return `<div class="item ${own ? 'own' : ''} ${locked ? 'locked' : ''}">
        <span class="i-ico">${u.icon}</span>
        <div class="i-body"><b>${esc(u.name)}</b><small>${esc(u.desc)}${u.upkeep ? ` Содержание ${rub(u.upkeep)}/день.` : ''}</small></div>
        ${own ? '<span class="chip">✓ есть</span>' : locked ? `<span class="chip sm">с главы ${u.minCh}</span>` :
          `<button class="btn go" data-buy="${id}" ${S.rub < u.price ? 'disabled' : ''}>${rub(u.price)}</button>`}
      </div>`;
    }).join('');
    modal(`<div class="m-head"><h3>🛒 Апгрейды и имущество</h3><button class="x" data-close>✕</button></div>
      <p class="muted">Свободно: ${rub(S.rub)}. Роскошь раньше времени повышает расходы и снижает доверие.</p>
      <div class="list">${items}</div>`, 'sheet');
  }

  function showTeam() {
    const people = D.hireable.map(id => {
      const c = D.characters[id], inTeam = E.hired(S, id), t = Math.round(S.trust[id]);
      const btn = inTeam ? '<span class="chip">✓ в команде</span>' : S.chapter < 5 ? '<span class="chip sm">с главы 5</span>'
        : `<button class="btn go" data-hire="${id}" ${t < 40 ? 'disabled' : ''}>${t < 40 ? 'Не доверяет' : 'Нанять'}</button>`;
      return `<div class="item ${inTeam ? 'own' : ''}"><span class="i-ico">${c.avatar}</span>
        <div class="i-body"><b>${esc(c.name)}</b> <small class="muted">${esc(c.role)} · доля ${Math.round(c.share * 100)}% дневной прибыли</small>
        <small>${esc(c.hireText)}</small>
        <div class="trust"><span>Доверие</span><div class="bar"><i style="width:${t}%"></i></div><b>${t}</b></div></div>${btn}</div>`;
    }).join('');
    const others = ['marat', 'sanya', 'max'].map(id => {
      const c = D.characters[id], t = Math.round(S.trust[id]);
      return `<div class="item mini"><span class="i-ico">${c.avatar}</span><div class="i-body"><b>${esc(c.name)}</b> <small class="muted">${esc(c.role)}</small>
        <div class="trust"><span>Доверие</span><div class="bar"><i style="width:${t}%"></i></div><b>${t}</b></div></div></div>`;
    }).join('');
    modal(`<div class="m-head"><h3>👥 Команда</h3><button class="x" data-close>✕</button></div>
      <p class="muted">Команда берёт долю прибыли только в плюсовые дни. В финале важны доверие Марата, Карима и Паши.</p>
      <div class="list">${people}</div><h4>Окружение</h4><div class="list">${others}</div>`, 'sheet');
  }

  function showBooks() {
    const st = S.stats, tax = S.chapter >= 4;
    modal(`<div class="m-head"><h3>📊 Учёт</h3><button class="x" data-close>✕</button></div>
      <div class="report-grid">
        <div><span>Оборот</span><b>${rub(S.turnover)}</b></div>
        <div><span>Прибыль сделок</span><b class="${S.profit >= 0 ? 'pos' : 'neg'}">${signed(S.profit)}</b></div>
        <div><span>Комиссии и конвертация</span><b class="neg">${rub(S.fees)}</b></div>
        <div><span>Потери (скам, ошибки)</span><b class="neg">${rub(st.lost)}</b></div>
        <div><span>Мошенников поймано</span><b class="pos">${st.caught}</b></div>
        <div><span>Ложных споров</span><b>${st.wrongDisputes}</b></div>
        <div><span>Расходы в день</span><b>${rub(E.dailyCost(S))}</b></div>
        <div><span>Лимит СБП (30 дн.)</span><b>${rub(S.sbpUsed)} / ${rub(E.sbpLimit(S))}</b></div>
      </div>
      <h4>🧾 Налоги ${tax ? `(${Math.round(E.taxRate(S) * 100)}% с прибыли)` : ''}</h4>
      ${tax ? `<div class="report-grid">
        <div><span>Налоговая копилка</span><b>${rub(S.taxReserve)}</b></div>
        <div><span>Долг перед налоговой</span><b class="${S.taxDebt > 0 ? 'neg' : ''}">${rub(S.taxDebt)}</b></div>
      </div>
      <label class="toggle"><input type="checkbox" data-tax ${S.taxOn || E.hired(S, 'grisha') ? 'checked' : ''} ${E.hired(S, 'grisha') ? 'disabled' : ''}>
        Откладывать налог сразу${E.hired(S, 'grisha') ? ' — этим занимается Гриша' : ''}</label>` : '<p class="muted">Налоги появятся после встречи с Маратом (глава 4).</p>'}
      <blockquote>«Сначала научись считать. Потом научись не терять. И только потом думай, как вырасти.» — Марат</blockquote>`, 'sheet');
  }

  function showMenu() {
    modal(`<div class="m-head"><h3>☰ Меню</h3><button class="x" data-close>✕</button></div>
      <div class="list">
        <button class="big-btn ghost" data-close>▶ Продолжить</button>
        <button class="big-btn ghost" data-howto>❔ Как играть</button>
        <button class="big-btn danger" data-restart-confirm>↻ Начать заново</button>
      </div>`, 'sheet small');
  }

  function showHowTo() {
    modal(`<div class="m-head"><h3>❔ Как играть</h3><button class="x" data-close>✕</button></div>
      <ul class="howto">
        <li><b>Капитал</b> = рубли + USDT по курсу. Цель каждой главы — дорасти до планки.</li>
        <li><b>Клиент покупает</b> — ты отпускаешь USDT, когда деньги пришли. Проверь, что отправитель — сам клиент, сумма сходится, а деньги видны в банке, а не только на скрине.</li>
        <li><b>Клиент продаёт</b> — ты платишь на его карту. Карта должна быть на имя клиента: перевод третьему лицу — это схема дропперов.</li>
        <li><b>⚠️ Спор</b> — отказ от подозрительного ордера. Поймал мошенника — репутация растёт. Обидел честного — падает.</li>
        <li><b>Банк-риск</b> растёт с каждой сделкой. От 48 — охлаждение, от 70 — запрос документов, от 88 — блокировка. Снижается ночью и от обычных покупок по карте.</li>
        <li><b>Стресс</b> выше 70 — шанс «толстого пальца». Энергия восстанавливается ночью.</li>
        <li>Не хватает USDT или рублей — игра сама докупит или продаст на бирже с комиссией 0,4%.</li>
      </ul>
      <button class="big-btn" data-close>Понятно</button>`, 'sheet');
  }

  // ---------- События ----------
  function setTab(t) {
    tab = t;
    document.querySelectorAll('.mtabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    document.body.dataset.tab = t;
    if (t === 'chat') { const f = $('chat-feed'); f.scrollTop = f.scrollHeight; }
  }

  function start(state) {
    S = state;
    shownNw = E.netWorth(S);
    chatSeen = 0;
    $('title').hidden = true;
    $('app').hidden = false;
    closeModal();
    setTab('board');
    save();
    render();
  }

  document.addEventListener('click', ev => {
    const t = ev.target.closest('button, input');
    if (!t) { if (ev.target === $('modal') && !S.ending && !S.report && !S.flash) closeModal(); return; }
    const d = t.dataset;
    if (d.accept) return act({ type: 'accept', id: +d.accept });
    if (d.dispute) return act({ type: 'dispute', id: +d.dispute });
    if (d.hustle) return act({ type: 'hustle', id: d.hustle });
    if (d.key) return act({ type: 'choose', key: +d.key, idx: +d.idx });
    if (d.buy) { act({ type: 'buy', id: d.buy }); if (!S.flash) showShop(); return; }
    if (d.hire) { act({ type: 'hire', id: d.hire }); if (!S.flash) showTeam(); return; }
    if ('tax' in d) { act({ type: 'tax' }); return showBooks(); }
    if ('ack' in d) { closeModal(); act({ type: 'ack' }); return; }
    if ('close' in d) return closeModal();
    if ('howto' in d) return showHowTo();
    if ('restart' in d) { localStorage.removeItem(SAVE); return start(E.newGame()); }
    if ('restartConfirm' in d) { if (confirm('Начать заново? Прогресс будет потерян.')) { localStorage.removeItem(SAVE); start(E.newGame()); } return; }
    if (d.tab) return setTab(d.tab);
    if (d.open === 'shop') return showShop();
    if (d.open === 'team') return showTeam();
    if (d.open === 'books') return showBooks();
    if (t.id === 'btn-day') {
      if (S.pending.length) { setTab('chat'); toast('Сначала ответь в чате 💬'); return; }
      return act({ type: 'endDay' });
    }
    if (t.id === 'btn-retail') return act({ type: 'retail' });
    if (t.id === 'btn-sound') { sound = !sound; localStorage.setItem(SOUND, sound ? 'on' : 'off'); renderTop(); if (sound) sfx.click(); return; }
    if (t.id === 'btn-menu') return showMenu();
    if (t.id === 'btn-new') { const had = loadSave(); if (had && !had.ending && !confirm('Начать заново? Сохранение будет перезаписано.')) return; return start(E.newGame()); }
    if (t.id === 'btn-continue') { const s = loadSave(); if (s) start(s); }
  });

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !$('modal').hidden && !S.ending && !S.report && !S.flash) closeModal();
  });

  // Титульный экран
  const existing = loadSave();
  if (existing && !existing.ending) {
    const b = $('btn-continue');
    b.hidden = false;
    b.textContent = `▶ Продолжить · глава ${existing.chapter}, день ${existing.day}`;
  }
  document.body.dataset.tab = 'board';
})();
