'use strict';
/**
 * P2P: С НУЛЯ (RU Market Edition 2026–2027)
 * API Client & Terminal Engine Controller
 * 
 * Взаимодействие с backend API (/api/play, /api/state, /api/action, /api/content)
 * и полное управление 12 разделами интерфейса Dark Financial Terminal.
 */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });
const quantity = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 });

let view = null;
let fullState = null;
let content = null;
let busy = false;
let uncertain = false;
let activeChatId = 'chat_local';

// Звуковой синтезатор Web Audio API для реалистичного терминального фидбека
let audioCtx = null;
function playSound(type) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    
    if (type === 'click') {
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.exponentialRampToValueAtTime(200, now + 0.04);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.04);
      osc.start(now);
      osc.stop(now + 0.04);
    } else if (type === 'success') {
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.setValueAtTime(880, now + 0.08);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.2);
      osc.start(now);
      osc.stop(now + 0.2);
    } else if (type === 'warn') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.setValueAtTime(180, now + 0.1);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.linearRampToValueAtTime(0.001, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    }
  } catch (e) {
    // Тихо игнорируем, если автозвук заблокирован политикой браузера
  }
}

function showToast(msg) {
  const toast = $('#toastNotice');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

function showError(message) {
  $('#errorText').textContent = message || '';
  $('#errorBanner').hidden = !message;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function updateControls() {
  const blocked = busy || !view || uncertain;
  document.querySelectorAll('button, input, select').forEach((control) => {
    if (control.id === 'retry') {
      control.disabled = busy;
    } else if (control.classList.contains('nav-tab')) {
      // Табы можно переключать всегда
      control.disabled = false;
    } else {
      control.disabled = blocked;
    }
  });
  $('#app').classList.toggle('is-loading', busy);
  $('#app').setAttribute('aria-busy', String(busy));
  const side = $('#dealSide') ? $('#dealSide').value : 'buy';
  if ($('#tradeSubmit')) {
    $('#tradeSubmit').textContent = side === 'sell' ? 'Продать USDT (Получить рубли)' : 'Купить USDT (Отдать рубли)';
  }
}

// Запрос к API
async function request(action) {
  if (busy || (action && (!view || uncertain))) return;
  busy = true;
  showError('');
  $('#requestStatus').textContent = action ? 'Отправка действия в ядро терминала…' : 'Синхронизация данных API…';
  updateControls();
  try {
    const response = await fetch('/api/play', action ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    } : { method: 'GET', cache: 'no-store' });

    const data = await response.json();
    if (!data || !data.view) throw new Error('Сервер не вернул состояние игры.');
    view = data.view;
    uncertain = false;

    // Фоновое чтение полного состояния для расширенных вкладок
    fetchFullState();

    render();
    if (!response.ok || data.ok !== true) {
      playSound('warn');
      showError(data.error || 'Действие отклонено финансовым комплаенсом.');
      $('#requestStatus').textContent = 'Отклонено: ' + (data.error || 'Ошибка');
    } else {
      if (action) {
        playSound('success');
        showToast('✓ Действие зафиксировано');
      }
      $('#requestStatus').textContent = action ? 'Действие сохранено.' : 'Состояние синхронизировано.';
    }
  } catch (error) {
    uncertain = true;
    playSound('warn');
    showError('Связь с API прервана. Обновите состояние.');
    $('#requestStatus').textContent = 'Ошибка сети API.';
  } finally {
    busy = false;
    updateControls();
  }
}

// Запрос полного состояния через /api/state
async function fetchFullState() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    const data = await res.json();
    if (data && data.ok) {
      fullState = data.state;
      renderExtendedPanels();
    }
  } catch (e) {}
}

// Запрос справочника через /api/content
async function fetchContent() {
  try {
    const res = await fetch('/api/content', { cache: 'no-store' });
    const data = await res.json();
    if (data && data.ok) {
      content = data.content;
      renderExtendedPanels();
    }
  } catch (e) {}
}

// Рендеринг основного VIEW (совместимо со всеми тестами)
function render() {
  if (!view) return;

  $('#rub').textContent = money.format(view.rub);
  $('#usdt').textContent = quantity.format(view.usdt) + ' USDT';
  $('#pnl').textContent = money.format(view.pnlNet);
  $('#pnl').classList.toggle('positive', view.pnlNet > 0);
  $('#pnl').classList.toggle('negative', view.pnlNet < 0);
  $('#day').textContent = 'День ' + view.day;
  $('#energy').textContent = quantity.format(view.energy) + ' / 100';
  $('#chapter').textContent = 'Глава ' + view.chapter;
  if ($('#chapterBadge')) $('#chapterBadge').textContent = 'Гл. ' + view.chapter;
  if ($('#buyRate')) $('#buyRate').textContent = money.format(view.market.buyRate);
  if ($('#sellRate')) $('#sellRate').textContent = money.format(view.market.sellRate);

  // Сюжетный блок
  const story = view.story;
  $('#storyTitle').textContent = story.title;
  $('#storyText').textContent = story.text;
  $('#objective').textContent = story.objective;
  $('#progressText').textContent = quantity.format(story.progress) + ' из ' + quantity.format(story.target);
  $('#goalProgress').max = story.target > 0 ? story.target : 1;
  $('#goalProgress').value = story.progress;
  $('#storyState').textContent = story.completed ? 'Эпизод завершён' : 'Ваш следующий шаг';
  $('#completion').hidden = !story.completed;

  // Выборы сюжета
  const choicesBox = $('#choices');
  choicesBox.textContent = '';
  for (const choice of story.choices) {
    const button = node('button', 'button choice-btn', choice.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      playSound('click');
      request({ type: 'choice', choiceId: choice.id });
    });
    choicesBox.append(button);
  }

  // Сообщения
  renderChatMessages();

  // Имущество (Inventory)
  const itemsContainer = $('#items');
  itemsContainer.textContent = '';
  for (const item of view.items) {
    const row = node('div', 'inventory-item' + (item.owned ? ' owned' : ''));
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid var(--line);';
    const desc = node('div', '');
    desc.append(node('strong', '', item.title), node('div', '', money.format(item.price)));
    row.append(desc);
    if (item.owned) {
      row.append(node('span', 'positive', '✓ В собственности'));
    } else {
      const btn = node('button', 'button', 'Приобрести');
      btn.type = 'button';
      btn.addEventListener('click', () => {
        playSound('click');
        request({ type: 'purchase', itemId: item.id });
      });
      row.append(btn);
    }
    itemsContainer.append(row);
  }

  // Журнал операций
  const logList = $('#log');
  logList.textContent = '';
  for (const entry of [...view.log].reverse()) {
    const kind = ['info', 'success', 'error'].includes(entry.kind) ? entry.kind : 'info';
    const li = node('li', 'log-item ' + kind, entry.text);
    logList.append(li);
  }
}

// Отрисовка сообщений чата (TG-Hub)
function renderChatMessages() {
  const container = $('#messages');
  if (!container) return;
  const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  container.textContent = '';

  // Если есть fullState, берем сообщения активного чата
  let msgs = [];
  if (fullState && fullState.chats && fullState.chats[activeChatId]) {
    msgs = fullState.chats[activeChatId].messages || [];
  } else if (view && view.messages) {
    msgs = view.messages.map(m => ({ from: m.author, text: m.text, options: [] }));
  }

  for (const msg of msgs) {
    const isOut = msg.from === 'Артём' || msg.author === 'Артём';
    const bubble = node('div', 'tg-bubble ' + (isOut ? 'outgoing' : 'incoming'));
    bubble.append(node('span', 'tg-author', msg.from || msg.author || 'Контрагент'));
    bubble.append(node('div', '', msg.text));

    // Симуляция голосового сообщения
    if ((msg.text || '').includes('голосовое') || (msg.text || '').includes('Слушай') || (msg.from || '').includes('Даня')) {
      const voice = node('div', 'voice-msg-player');
      const playBtn = node('button', 'button-quiet', '▶ 0:14');
      playBtn.style.padding = '2px 6px';
      playBtn.style.fontSize = '11px';
      playBtn.onclick = () => playSound('click');
      const wave = node('div', 'voice-waveform');
      for (let i = 0; i < 18; i++) {
        const bar = node('div', 'wave-bar');
        bar.style.height = (4 + Math.sin(i * 0.8) * 12) + 'px';
        wave.append(bar);
      }
      voice.append(playBtn, wave);
      bubble.append(voice);
    }

    // Симуляция видео-кружочка Ивана Ролекса
    if ((msg.from || '').includes('Иван') && (msg.text || '').includes('маза')) {
      const circle = node('div', 'video-circle', '⌚');
      bubble.append(circle);
    }

    // Интерактивные варианты ответов
    if (msg.options && msg.options.length) {
      const optWrap = node('div', '');
      optWrap.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-top:8px;';
      for (const opt of msg.options) {
        const optBtn = node('button', 'button', '💬 ' + opt.text);
        optBtn.style.fontSize = '12px';
        optBtn.style.padding = '6px 10px';
        optBtn.style.justifyContent = 'flex-start';
        optBtn.onclick = () => {
          playSound('click');
          request({ type: 'choice', choiceId: opt.id });
        };
        optWrap.append(optBtn);
      }
      bubble.append(optWrap);
    }

    container.append(bubble);
  }

  if (isNearBottom || container.childElementCount <= 4) {
    container.scrollTop = container.scrollHeight;
  }
}

// Отрисовка расширенных вкладок из fullState
function renderExtendedPanels() {
  if (!fullState) return;

  // Обновление HUD
  if ($('#city')) $('#city').textContent = fullState.city === 'NOVOZAROVSK' ? 'Новозаровск' : (fullState.city === 'BRYANSK' ? 'Брянск' : 'Москва');
  if ($('#stressMeter')) $('#stressMeter').textContent = Math.round(fullState.stress) + '%';
  if ($('#focusMeter')) $('#focusMeter').textContent = Math.round(fullState.focus) + '%';

  // 1. Инспектор сделок
  const order = fullState.activeOrder;
  if (order) {
    if ($('#orderId')) $('#orderId').textContent = order.orderId;
    if ($('#buyerExchangeName')) $('#buyerExchangeName').textContent = order.counterpartyName;
    if ($('#orderVolume')) $('#orderVolume').textContent = order.amountUsdt + ' USDT (' + money.format(order.totalRub) + ')';
    if ($('#bankPushSender')) $('#bankPushSender').textContent = 'Перевод ' + money.format(order.totalRub) + ' от ' + order.bankSender;
    if ($('#receiptMetadata')) {
      $('#receiptMetadata').textContent = order.isReceiptAuthentic 
        ? '✓ Метаданные PDF чистые: Т-Банк Gateway, ЭЦП верифицирована'
        : '⚠️ ВНИМАНИЕ: обнаружены следы Photoshop / PDF-редактора! Несовпадение шрифта!';
      $('#receiptMetadata').style.color = order.isReceiptAuthentic ? 'var(--accent)' : 'var(--danger)';
    }
  }

  // 2. Банки
  const banksContainer = $('#banksContainer');
  if (banksContainer && fullState.banks) {
    banksContainer.textContent = '';
    for (const [bid, b] of Object.entries(fullState.banks)) {
      const card = node('div', 'bank-card');
      const header = node('div', '');
      header.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';
      header.append(node('strong', '', b.name));
      const statusBadge = node('span', 'badge', b.status === 'ok' ? '✓ Зеленый коридор' : (b.status === 'blocked' ? '⛔ Блок 115-ФЗ' : '⚠️ Проверка'));
      statusBadge.style.color = b.status === 'ok' ? 'var(--accent)' : 'var(--danger)';
      header.append(statusBadge);

      const riskWrap = node('div', '');
      riskWrap.append(node('div', '', 'Индекс риска комплаенса: ' + b.riskScore + '/100'));
      const meter = node('div', 'bank-risk-meter');
      const fill = node('div', 'risk-fill');
      fill.style.width = b.riskScore + '%';
      fill.style.background = b.riskScore < 50 ? 'var(--accent)' : (b.riskScore < 80 ? 'var(--warning)' : 'var(--danger)');
      meter.append(fill);
      riskWrap.append(meter);

      card.append(header, riskWrap);

      if (b.status !== 'ok') {
        const appealBtn = node('button', 'button button-primary', 'Подать КУДиР Гриши (Снять 115-ФЗ)');
        appealBtn.style.marginTop = '8px';
        appealBtn.onclick = () => {
          playSound('click');
          request({ type: 'bank_appeal', bankId: bid });
        };
        card.append(appealBtn);
      }
      banksContainer.append(card);
    }
  }

  // 3. Команда (RPG)
  const teamContainer = $('#teamContainer');
  if (teamContainer && content && content.characters) {
    teamContainer.textContent = '';
    for (const char of content.characters) {
      const tVal = fullState.trust ? (fullState.trust[char.id] || 50) : 50;
      const card = node('div', 'member-card');
      const header = node('div', '');
      header.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px;';
      header.append(node('span', '', char.avatar || '👤'), node('strong', '', char.name));
      
      const role = node('div', '', char.role);
      role.style.cssText = 'font-size:11px; color:var(--muted); margin-bottom:6px;';

      const trustInfo = node('div', '', 'Доверие: ' + tVal + '% • Аппетит к риску: ' + char.riskAppetite + '%');
      trustInfo.style.fontSize = '12px';

      const tBar = node('div', 'trust-bar');
      const tFill = node('div', 'trust-fill');
      tFill.style.width = tVal + '%';
      tBar.append(tFill);

      card.append(header, role, trustInfo, tBar);

      // Кнопки взаимодействия
      if (char.id === 'karim') {
        const btn = node('button', 'button-quiet', '📊 Запросить риск-аудит');
        btn.onclick = () => request({ type: 'team_action', actionId: 'audit_karim' });
        card.append(btn);
      } else if (char.id === 'pasha') {
        const btn = node('button', 'button-quiet', '🛡️ Инструктаж безопасности');
        btn.onclick = () => request({ type: 'team_action', actionId: 'security_pasha' });
        card.append(btn);
      } else if (char.id === 'grisha') {
        const btn = node('button', 'button-quiet', '📑 Свести налоги за месяц');
        btn.onclick = () => request({ type: 'team_action', actionId: 'tax_grisha' });
        card.append(btn);
      } else if (char.id === 'ivan') {
        const btn = node('button', 'button-quiet', '⌚ Привлечь VIP-клиента');
        btn.onclick = () => request({ type: 'team_action', actionId: 'vip_ivan' });
        card.append(btn);
      }

      teamContainer.append(card);
    }
  }

  // 4. Подработки в Главе 1
  const hustlesContainer = $('#hustlesContainer');
  if (hustlesContainer) {
    hustlesContainer.textContent = '';
    const hustles = [
      { id: 'loader', title: 'Разгрузка спортпита с Даней', reward: 1800, energy: 25, desc: 'Физическая работа на складе. Даня подстрахует.' },
      { id: 'avito', title: 'Продажа видеокарты на Авито', reward: 3200, energy: 10, desc: 'Старая GTX 1060 из домашнего системника (разово).' },
      { id: 'carwash', title: 'Ночная смена на автомойке', reward: 1500, energy: 20, desc: 'Мойка такси и иномарок. Быстрые деньги.' },
      { id: 'courier', title: 'Доставка документов по городу', reward: 2200, energy: 30, desc: 'Пеший курьер по Брянску/Новозаровску.' },
    ];
    for (const h of hustles) {
      const card = node('div', 'hustle-card');
      card.append(node('strong', '', h.title), node('p', '', h.desc));
      const foot = node('div', '');
      foot.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-top:12px;';
      foot.append(node('span', 'positive', '+' + money.format(h.reward)));
      const btn = node('button', 'button', 'Взять смену (-' + h.energy + '⚡)');
      btn.onclick = () => {
        playSound('click');
        request({ type: 'hustle', hustleId: h.id });
      };
      foot.append(btn);
      card.append(foot);
      hustlesContainer.append(card);
    }
  }

  // 5. OTC предложения
  const otcBox = $('#otcContainer');
  if (otcBox && fullState.otcOffers) {
    otcBox.textContent = '';
    for (const offer of fullState.otcOffers) {
      const row = node('div', 'terminal-card');
      row.style.padding = '12px';
      row.innerHTML = `
        <div style="display:flex; justify-content:space-between;">
          <strong>${offer.title}</strong>
          <span class="positive">${offer.rateRub} ₽/USDT</span>
        </div>
        <div style="font-size:12px; color:var(--muted); margin:4px 0;">Объём: ${offer.volumeUsdt} USDT (${money.format(offer.totalRub)}) • Создатель: ${offer.creator}</div>
        <div style="font-size:12px;">Указанный гарант: <strong style="color:var(--warning);">${offer.guarantor}</strong></div>
      `;
      const btn = node('button', 'button button-primary', 'Верифицировать гаранта и провести сделку');
      btn.style.marginTop = '8px';
      btn.onclick = () => {
        playSound('click');
        request({ type: 'verify_guarantor', offerId: offer.id });
      };
      row.append(btn);
      otcBox.append(row);
    }
  }

  // 6. Бизнес и налоги
  if ($('#ipStatus')) $('#ipStatus').textContent = fullState.isIpRegistered ? 'ИП Воронов А.В. (ОГРНИП 326...)' : 'Физлицо (Личные карты)';
  if ($('#taxModeLabel')) $('#taxModeLabel').textContent = fullState.taxMode || 'НДФЛ 13%';
  if ($('#taxReserve')) $('#taxReserve').textContent = money.format(fullState.taxReserveRub || 0);
  if ($('#turnoverMonth')) $('#turnoverMonth').textContent = money.format(fullState.turnoverRub || 0);

  // Финальный экран
  if (fullState.ending) {
    showToast('🏆 СЮЖЕТ ЗАВЕРШЁН: ' + fullState.ending.title);
  }
}

// Быстрое заполнение сделки из стакана
window.prefillDeal = function(side, qty, price) {
  playSound('click');
  $('#dealSide').value = side;
  $('#dealAmount').value = qty;
  updateControls();
  window.scrollTo({ top: $('#dealForm').offsetTop - 80, behavior: 'smooth' });
};

// Запуск арбитража
window.runArbitrage = function(route) {
  playSound('click');
  const amount = view && view.rub >= 50000 ? 500 : 30;
  request({ type: 'buy', amount: amount });
  setTimeout(() => request({ type: 'sell', amount: amount }), 300);
};

// Переключение табов навигации
$$('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    playSound('click');
    $$('.nav-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const targetId = tab.getAttribute('data-tab');
    $$('.tab-pane').forEach(p => p.hidden = true);
    const targetPane = $('#' + targetId);
    if (targetPane) targetPane.hidden = false;
  });
});

// Переключение чатов в TG-Hub
$$('.tg-chat-item').forEach((item) => {
  item.addEventListener('click', () => {
    playSound('click');
    $$('.tg-chat-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    activeChatId = item.getAttribute('data-chat');
    const nameEl = item.querySelector('.tg-chat-name');
    if ($('#chatTitle') && nameEl) $('#chatTitle').textContent = nameEl.textContent;
    renderChatMessages();
  });
});

// Кнопки инспектора ордеров
if ($('#btnConfirmOrder')) {
  $('#btnConfirmOrder').addEventListener('click', () => {
    playSound('click');
    request({ type: 'inspect_order', decision: 'confirm' });
  });
}
if ($('#btnAppealOrder')) {
  $('#btnAppealOrder').addEventListener('click', () => {
    playSound('warn');
    request({ type: 'inspect_order', decision: 'appeal' });
  });
}

// Форма сделки
function clearAmountError() {
  $('#amountError').hidden = true;
  $('#amountError').textContent = '';
  $('#dealAmount').removeAttribute('aria-invalid');
}

$('#dealForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy || !view || uncertain) return;
  clearAmountError();
  const raw = $('#dealAmount').value.trim();
  const amount = Number(raw.replace(',', '.'));
  if (!/^\d+(?:[.,]\d+)?$/.test(raw) || !Number.isFinite(amount) || amount <= 0) {
    $('#amountError').textContent = 'Введите количество больше нуля, например 30 или 0.5 USDT.';
    $('#amountError').hidden = false;
    $('#dealAmount').setAttribute('aria-invalid', 'true');
    $('#dealAmount').focus();
    return;
  }
  request({ type: $('#dealSide').value, amount });
});

$('#dealAmount').addEventListener('input', clearAmountError);
$('#dealSide').addEventListener('change', updateControls);

$('#advanceDay').addEventListener('click', () => {
  playSound('click');
  request({ type: 'advance_day' });
});

$('#newGame').addEventListener('click', () => {
  if (busy || !view || uncertain) return;
  if (window.confirm('Начать новую игру? Прогресс и баланс будут сброшены к стартовым 3 700 ₽.')) {
    clearAmountError();
    request({ type: 'new' });
  }
});

$('#retry').addEventListener('click', () => request());

// Инициализация
updateControls();
fetchContent();
request();
