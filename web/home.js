// Guided homepage: 1 pick models → 2 choose an amount → 3 choose where you use it → 4 pay. Every step has a sensible
// default, so a buyer who agrees with them can pay at once; a pinned bar at the bottom always shows the current
// order and its Pay button, so the button is never "somewhere up the page".
import { loadModels, renderModels, money, bonusText, callsFor, compactNum } from '/models.js?v=11';
import { buy } from '/shop.js?v=4';
import { USES, setupFor, savePlan, copyText, CC_DEFAULT, CODEX_DEFAULT, CHAT_DEFAULT } from '/setup.js?v=2';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
};
const BASE = location.origin + '/v1';
const PLACEHOLDER = 'sk-your-key';

// the short list in step 1; everything else is one click away in "All models". Only models the shop lists show up.
const PICKS = [
  ['claude-opus-5-5', 'Newest Claude Opus'],
  ['claude-opus-4-8', 'Lowest-cost Claude'],
  ['claude-sonnet-5-5', 'Claude Sonnet'],
  ['gpt-6-astra', 'Newest GPT (Codex)'],
  ['gpt-6.1-sol', 'Low-cost GPT'],
  ['deepseek-flash', 'DeepSeek Flash, lowest cost'],
  ['kimi-k3', 'Kimi by Moonshot'],
  ['gemini-3.1-pro', 'Gemini by Google'],
];
// upstream routes that only accept Claude Code clients (same list as models.js)
const CLAUDE_CODE_ONLY = new Set(['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8']);

const state = {
  picked: new Set(),
  currency: 'eur',
  amount: null, // string, as /api/shop lists it
  use: 'claude-code',
  useTouched: false, // once the buyer picks a client, model ticks no longer change it
  busy: false,
};
let models = []; // /api/models
let byId = new Map();
let quote = null; // /api/shop?currency=… for the selected currency
let acctFiat = 'eur'; // the currency model prices and key credit are in
let table = { sync() {} };

export async function mountHome({ ref }) {
  $('#buy-currency').onchange = () => {
    state.currency = $('#buy-currency').value;
    void loadQuote();
  };
  $('#pay-btn').onclick = pay;
  $('#bar-btn').onclick = pay;
  $('#setup-copy').onclick = async (e) => {
    await copyText($('#setup'));
    e.target.textContent = 'Copied ✓';
    setTimeout(() => (e.target.textContent = 'Copy'), 1600);
  };
  state.ref = ref;
  watchBar();
  renderUses();

  const data = await loadModels();
  if (data) {
    models = data.list;
    byId = new Map(models.map((m) => [m.model, m]));
    acctFiat = data.shop.accountFiat ?? data.shop.fiat;
    for (const u of document.querySelectorAll('.unit')) u.textContent = acctFiat.toUpperCase();
    for (const n of document.querySelectorAll('.nmodels')) n.textContent = String(models.length);
    // default picks (operator's choice): newest Claude Opus, newest GPT, the cheapest strong chat model
    for (const id of [CC_DEFAULT, CODEX_DEFAULT, CHAT_DEFAULT]) if (byId.has(id)) state.picked.add(id);
    if (!state.picked.size && models[0]) state.picked.add(models[0].model);
    table = await renderModels($('#models'), { data, pick: { picked: state.picked, onChange: () => changed() } });
  } else {
    $('#picks').replaceChildren(el('p', { className: 'hint', textContent: 'The model list is not available right now — every key still works with all models.' }));
  }
  changed();
  await loadQuote();
}

/** Something in step 1 changed: redraw everything that depends on the picked models. */
function changed() {
  if (!state.useTouched) state.use = suggestedUse();
  renderPicks();
  renderAmounts();
  renderUses();
  renderSummary();
}

// ---------------------------------------------------------------- step 1: models
function renderPicks() {
  if (!models.length) return;
  const shown = PICKS.filter(([id]) => byId.has(id));
  // models ticked in the full list that are not on the short list get a card too, so the selection is visible here
  const extra = [...state.picked].filter((id) => !shown.some(([s]) => s === id) && byId.has(id)).map((id) => [id, byId.get(id).vendor]);
  const cards = [...shown, ...extra].map(([id, label]) => {
    const m = byId.get(id);
    const on = state.picked.has(id);
    const price = m.perCall !== undefined ? `${fmt(m.perCall)} per image` : `${fmt(m.output)} per 1M output`;
    const b = el('button', { type: 'button', className: 'pickcard' + (on ? ' on' : ''), ariaPressed: String(on) },
      el('span', { className: 'pc-check', ariaHidden: 'true' }),
      el('code', { textContent: id }),
      el('span', { className: 'pc-label', textContent: label }),
      el('span', { className: 'pc-meta' },
        price,
        m.endpoints.includes('anthropic') && el('span', { className: 'badge anthropic', textContent: CLAUDE_CODE_ONLY.has(id) ? 'Claude Code only' : 'Claude Code' })),
    );
    b.onclick = () => {
      state.picked.has(id) ? state.picked.delete(id) : state.picked.add(id);
      table.sync();
      changed();
    };
    return b;
  });
  $('#picks').replaceChildren(...cards);
  const n = state.picked.size;
  $('#picks-note').textContent = n
    ? `${n} picked. You are not locked in: the key works with every model, picking only sizes the key below.`
    : 'Nothing picked — that is fine too: the key works with every model. Pick one to see what an amount buys.';
}

// ---------------------------------------------------------------- step 2: amount
async function loadQuote() {
  const cur = state.currency;
  $('#amounts').replaceChildren();
  say('#amount-msg', 'Loading amounts…');
  try {
    const r = await fetch('/api/shop?currency=' + cur);
    const q = await r.json();
    if (cur !== state.currency) return; // a newer currency switch won
    if (!r.ok) throw new Error(q.error);
    quote = q;
    if (q.support) { $('#support a').href = q.support; $('#support').hidden = false; }
    if (q.bitcoinEnabled) $('#methods').textContent = 'Lightning, Cashu ecash or on-chain BTC';
    const ok = q.enabled ? q.amounts : [];
    // keep the buyer's amount when it still exists in this currency, else the smallest one on sale
    if (!ok.includes(state.amount)) state.amount = ok[0] ?? null;
    say('#amount-msg', !q.enabled
      ? 'No amounts on sale right now. Try another currency or check back later.'
      : cur === q.accountFiat ? '' : `The key holds ${q.accountFiat.toUpperCase()} credit · 1 ${cur.toUpperCase()} ≈ ${Number(q.accountRate.toFixed(4))} ${q.accountFiat.toUpperCase()}. Final quote on the next page.`);
  } catch (e) {
    quote = null;
    state.amount = null;
    say('#amount-msg', e.message + ' ');
    $('#amount-msg').append(el('button', { type: 'button', textContent: 'Retry', onclick: loadQuote }));
  }
  renderAmounts();
  renderSummary();
}

/** Account-currency credit an amount puts on the key: paid × rate, plus its bonus. */
const creditOf = (a) => Number(a) * (quote?.accountRate ?? 1) * (1 + (quote?.bonus?.[a] ?? 0) / 100);
const acct = () => quote?.accountFiat ?? acctFiat;
const fmt = (x) => money(x, acct(), x < 1 ? 3 : 2);
const pickedModels = () => [...state.picked].map((id) => byId.get(id)).filter(Boolean);

/** "≈ 152 chats" for one model, "≈ 120 – 3.6K chats" across several. */
function estimateText(credit) {
  const ms = pickedModels();
  if (!ms.length) return '';
  const chat = ms.filter((m) => m.perCall === undefined);
  const list = chat.length ? chat : ms;
  const n = list.map((m) => callsFor(m, credit));
  const lo = Math.min(...n);
  const hi = Math.max(...n);
  const unit = chat.length ? 'chats' : 'images';
  return `≈ ${lo === hi ? compactNum(lo) : `${compactNum(lo)} – ${compactNum(hi)}`} ${unit}`;
}

function renderAmounts() {
  const box = $('#amounts');
  if (!quote?.enabled) {
    box.replaceChildren();
    $('#estimate').replaceChildren();
    return;
  }
  const cur = state.currency;
  box.replaceChildren(...(quote.tiers ?? quote.amounts).map((a) => {
    const available = quote.amounts.includes(a);
    const on = a === state.amount;
    const bonus = bonusText(quote, a);
    const b = el('button', { type: 'button', className: 'amountcard' + (on ? ' on' : ''), disabled: !available, ariaPressed: String(on) },
      el('b', { textContent: money(Number(a), cur) }),
      bonus && el('em', { textContent: bonus }),
      quote.sats?.[a] && el('small', { textContent: '≈ ' + quote.sats[a].toLocaleString('en') + ' sat' }),
      available
        ? el('span', { className: 'est', textContent: estimateText(creditOf(a)) })
        : el('span', { className: 'est', textContent: quote.amounts.length ? 'Sold out right now' : 'Sold out' }),
    );
    b.onclick = () => {
      state.amount = a;
      renderAmounts();
      renderSummary();
    };
    return b;
  }));
  renderEstimate();
}

/** The detail under the amount cards: per picked model, what the selected amount buys. */
function renderEstimate() {
  const box = $('#estimate');
  const ms = pickedModels();
  if (!state.amount || !ms.length) {
    box.replaceChildren();
    return;
  }
  const credit = creditOf(state.amount);
  const paid = money(Number(state.amount), state.currency);
  const head = el('p', { className: 'calc-head', textContent: `What a ${paid} key buys` },
    el('span', { className: 'mcount', textContent: ` · ${money(credit, acct())} of credit${quote.bonus?.[state.amount] ? ' incl. bonus' : ''}` }));
  const t = el('table', { className: 'calls prices' });
  t.innerHTML = '<thead><tr><th class="name">Model</th><th>Chats*</th><th>or output tokens</th></tr></thead>';
  const tb = el('tbody');
  for (const m of ms) {
    const per = m.perCall !== undefined;
    tb.append(el('tr', {},
      el('td', { className: 'name' }, el('code', { textContent: m.model })),
      el('td', { textContent: per ? `${compactNum(callsFor(m, credit))} images` : compactNum(callsFor(m, credit)) }),
      el('td', { textContent: per ? '—' : compactNum((credit / m.output) * 1e6) })));
  }
  t.append(tb);
  box.replaceChildren(head, el('div', { className: 'scroll' }, t),
    el('p', { className: 'hint', textContent: '*A chat call = 2K tokens in + 500 out. Cached input is cheaper, so real use usually stretches further. Run out? Top up the same key from its page.' }));
}

// ---------------------------------------------------------------- step 3: where you use it
function suggestedUse() {
  const ms = pickedModels();
  if (!ms.length || ms.some((m) => m.endpoints.includes('anthropic'))) return 'claude-code';
  if (ms.some((m) => /^gpt-/.test(m.model) && m.perCall === undefined)) return 'codex';
  return 'app';
}

/** The model the setup snippet names: the first picked model that client can use, else its default. */
function setupModel(use = state.use) {
  const ms = pickedModels().filter((m) => m.perCall === undefined);
  if (use === 'claude-code') return ms.find((m) => m.endpoints.includes('anthropic'))?.model ?? CC_DEFAULT;
  if (use === 'codex') return ms.find((m) => /^gpt-/.test(m.model))?.model ?? CODEX_DEFAULT;
  return ms.find((m) => !CLAUDE_CODE_ONLY.has(m.model))?.model ?? CHAT_DEFAULT;
}

function renderUses() {
  $('#uses').replaceChildren(...USES.map((u) => {
    const on = u.id === state.use;
    const b = el('button', { type: 'button', role: 'radio', className: 'usecard' + (on ? ' on' : ''), ariaChecked: String(on) },
      el('b', { textContent: u.name }), el('span', { textContent: u.sub }));
    b.onclick = () => {
      state.use = u.id;
      state.useTouched = true;
      renderUses();
      renderSummary();
    };
    return b;
  }));
  const s = setupFor(state.use, { base: BASE, key: PLACEHOLDER, model: setupModel() });
  $('#setup-hint').textContent = s.hint;
  $('#setup').value = s.text;
  $('#setup').rows = s.rows;
  const ms = pickedModels();
  let warn = '';
  if (state.use === 'claude-code' && ms.length && !ms.some((m) => m.endpoints.includes('anthropic'))) {
    warn = `Claude Code needs a Claude model, so this uses ${CC_DEFAULT}. The models you picked work in the other apps.`;
  } else if (state.use !== 'claude-code' && ms.some((m) => CLAUDE_CODE_ONLY.has(m.model))) {
    warn = 'Claude Opus 4.6–4.8 here answer Claude Code only. In other apps use another Claude, e.g. claude-opus-5-5.';
  }
  say('#use-warn', warn);
}

// ---------------------------------------------------------------- step 4: pay (+ the pinned bar)
function renderSummary() {
  const use = USES.find((u) => u.id === state.use);
  const a = state.amount;
  const can = !!(a && quote?.enabled && !state.busy);
  const paid = a ? money(Number(a), state.currency) : '';
  const bonus = a ? bonusText(quote, a) : '';
  const rows = [
    ['Key', a ? `${paid}${bonus ? ` · ${bonus}` : ''}` : 'pick an amount in step 2'],
    ['You pay', a && quote?.sats?.[a] ? `≈ ${quote.sats[a].toLocaleString('en')} sat` : '—'],
    ['Models', (state.picked.size ? [...state.picked].slice(0, 3).join(', ') + (state.picked.size > 3 ? ` +${state.picked.size - 3} more` : '') + ' — ' : '')
      + `the key works with all ${models.length || ''} models`.replace('  ', ' ')],
    ['Setup for', use.name],
  ];
  $('#summary').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
  $('#pay-btn').disabled = !can;
  $('#pay-btn').textContent = state.busy ? 'Creating your order…' : a ? `Pay ${paid} in bitcoin →` : 'Pick an amount first';
  $('#bar-text').replaceChildren(
    el('b', { textContent: a ? `${paid} key` : 'No amount yet' }),
    el('span', { textContent: [bonus, a && quote?.sats?.[a] && `≈ ${quote.sats[a].toLocaleString('en')} sat`, `for ${use.name}`].filter(Boolean).join(' · ') }));
  $('#bar-btn').disabled = !can;
  $('#bar-btn').textContent = state.busy ? '…' : a ? `Pay ${paid} →` : 'Choose amount';
  if (!a) $('#bar-btn').disabled = false; // then it scrolls to step 2 instead
}

async function pay() {
  if (!state.amount) {
    $('#s2').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (state.busy) return;
  state.busy = true;
  say('#pay-msg', '');
  renderSummary();
  // the key page opens on the setup chosen here, with the real key filled in
  savePlan({ use: state.use, model: setupModel() });
  try {
    await buy({ money: state.amount, currency: state.currency, ref: state.ref });
  } catch (e) {
    state.busy = false;
    say('#pay-msg', e.message);
    renderSummary();
    $('#s4').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/** Show the pinned bar once the hero is gone, hide it while the real Pay button is on screen. */
function watchBar() {
  const seen = { hero: true, pay: false };
  const update = () => ($('#bar').hidden = seen.hero || seen.pay);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) seen[e.target === $('.hero') ? 'hero' : 'pay'] = e.isIntersecting;
    update();
  });
  io.observe($('.hero'));
  io.observe($('#pay-btn'));
}

function say(sel, text) {
  const e = $(sel);
  e.textContent = text;
  e.hidden = !text;
}
