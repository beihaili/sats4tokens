// Models & prices table (key shop): GET /api/models, grouped by vendor. Used by the buy page and the key page.
// The buy page also gets a calculator: tick models, pick an amount, see how many tokens that key buys.
// Prices come in the gateway's FIAT (from /api/shop), shown with its symbol.
const SYMBOLS = { usd: '$', eur: '€', cny: '¥', gbp: '£' };
/** `money(2, 'eur')` → "€2"; `digits` = decimals kept (trailing zeros dropped). */
export const money = (x, fiat, digits = 2) => {
  const n = String(Number(x.toFixed(digits)));
  const s = SYMBOLS[fiat];
  return s ? s + n : `${n} ${fiat.toUpperCase()}`;
};
/** "+5% bonus" for an amount, from /api/shop's `bonus` tiers ({"5": 5}); '' when none. */
export const bonusText = (shop, a) => (shop?.bonus?.[String(Number(a))] ? `+${shop.bonus[String(Number(a))]}% bonus` : '');
let FIAT = 'usd';
let BONUS = {};
const fmt = (x) => (x === undefined ? '—' : money(x, FIAT, x < 1 ? 3 : 2));
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 });
const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);

// ticked on first load (when they exist): one of each kind, from strongest to cheapest
const DEFAULT_PICKS = ['claude-opus-4-8', 'gpt-6.1-sol', 'deepseek-v4-flash', 'glm-5.3-flash'];
// a "typical chat call" for the calls column: 2K tokens in (question + context), 500 out (answer)
const CHAT_IN = 2000;
const CHAT_OUT = 500;

/**
 * Render the price table into `box`. With `calc: {amounts}` (buy page) each row gets a checkbox and a
 * calculator above the table shows, for every ticked model, what one key of the chosen amount buys.
 */
export async function renderModels(box, { calc } = {}) {
  const [r, shop] = await Promise.all([fetch('/api/models'), fetch('/api/shop').then((x) => x.json())]);
  if (!r.ok) {
    box.closest('section').hidden = true;
    return;
  }
  FIAT = shop.fiat;
  BONUS = shop.bonus ?? {};
  // the section's hint says "<span class="unit"></span> per 1M tokens"
  for (const u of box.closest('section').querySelectorAll('.unit')) u.textContent = FIAT.toUpperCase();
  const list = await r.json();
  const picked = new Set(DEFAULT_PICKS.filter((n) => list.some((m) => m.model === n)));
  let amount = Number(calc?.amounts?.[0] ?? 1);

  const calcBox = el('div', { className: 'calc' });
  const draw = () => drawCalc(calcBox, list, picked, amount, calc.amounts, (a) => ((amount = a), draw()));

  const table = el('table', { className: 'calls prices' });
  const cols = calc ? 5 : 4;
  table.innerHTML = `<thead><tr>${calc ? '<th class="pick"></th>' : ''}<th class="name">Model</th><th>Input</th><th>Output</th><th class="cached">Cached</th></tr></thead>`;
  const tbody = el('tbody');
  for (const v of [...new Set(list.map((m) => m.vendor))]) {
    const head = el('tr', { className: 'vendor' });
    const cell = el('td', { colSpan: cols, textContent: v });
    // every model speaks the OpenAI API; mark vendors whose models also speak Anthropic's (= Claude Code works)
    if (list.some((m) => m.vendor === v && m.endpoints.includes('anthropic'))) {
      cell.append(el('span', { className: 'badge anthropic', textContent: 'Claude Code' }));
    }
    head.append(cell);
    tbody.append(head);
    for (const m of list.filter((x) => x.vendor === v)) {
      const tr = el('tr');
      if (calc) {
        const cb = el('input', { type: 'checkbox', checked: picked.has(m.model), ariaLabel: `compare ${m.model}` });
        cb.onchange = () => {
          cb.checked ? picked.add(m.model) : picked.delete(m.model);
          tr.classList.toggle('picked', cb.checked);
          draw();
        };
        tr.classList.toggle('picked', cb.checked);
        // the whole row toggles, easier on a phone. (Block body: an onclick returning false would cancel the tick.)
        tr.onclick = (e) => {
          if (e.target !== cb) cb.click();
        };
        const td = el('td', { className: 'pick' });
        td.append(cb);
        tr.append(td);
      }
      const name = el('td', { className: 'name' });
      name.append(el('code', { textContent: m.model }));
      if (m.fastTier) name.append(el('span', { className: 'badge', textContent: 'fast ×2' }));
      tr.append(name);
      if (m.perCall !== undefined) {
        tr.append(el('td', { colSpan: 3, textContent: `${fmt(m.perCall)} per image` }));
      } else {
        for (const x of [m.input, m.output]) tr.append(el('td', { textContent: fmt(x) }));
        tr.append(el('td', { className: 'cached', textContent: fmt(m.cacheRead) }));
      }
      tbody.append(tr);
    }
  }
  table.append(tbody);
  const wrap = el('div', { className: 'scroll' });
  wrap.append(table);
  if (calc) {
    draw();
    box.replaceChildren(calcBox, wrap);
  } else {
    box.replaceChildren(wrap);
  }
}

/** The calculator: amount buttons + one row per ticked model (all-input, all-output, typical chat calls). */
function drawCalc(box, list, picked, amount, amounts, setAmount) {
  const tabs = el('div', { className: 'tabs' });
  for (const a of amounts) {
    const b = el('button', { textContent: money(Number(a), FIAT) + (BONUS[a] ? ` +${BONUS[a]}%` : ''), className: Number(a) === amount ? 'on' : '' });
    b.onclick = () => setAmount(Number(a));
    tabs.append(b);
  }
  const rows = list.filter((m) => picked.has(m.model));
  const paid = amount;
  amount = paid * (1 + (BONUS[String(paid)] ?? 0) / 100); // what the key holds: the bonus is spendable like the rest
  const out = el('div', { className: 'scroll' });
  if (!rows.length) {
    out.append(el('p', { className: 'hint', textContent: 'Tick models in the list below to compare them.' }));
  } else {
    const t = el('table', { className: 'calls prices' });
    t.innerHTML = '<thead><tr><th class="name">Model</th><th>All input</th><th>All output</th><th>Chats*</th></tr></thead>';
    const tb = el('tbody');
    for (const m of rows) {
      const tr = el('tr');
      const name = el('td', { className: 'name' });
      name.append(el('code', { textContent: m.model }));
      tr.append(name);
      if (m.perCall !== undefined) {
        tr.append(el('td', { colSpan: 3, textContent: `${Math.floor(amount / m.perCall)} images` }));
      } else {
        // prices are FIAT per 1M tokens, so `amount` buys amount / price million tokens
        const chat = (CHAT_IN * m.input + CHAT_OUT * m.output) / 1e6;
        for (const s of [compact.format((amount / m.input) * 1e6), compact.format((amount / m.output) * 1e6), compact.format(Math.floor(amount / chat))]) {
          tr.append(el('td', { textContent: s }));
        }
      }
      tb.append(tr);
    }
    t.append(tb);
    out.append(t);
  }
  const head = el('p', { className: 'calc-head', textContent: 'What one key buys:' });
  const note = el('p', {
    className: 'hint',
    textContent: `Tokens if the whole ${money(amount, FIAT)}${amount > paid ? ` (${money(paid, FIAT)} + bonus)` : ''} goes to input, or to output. *Chat call = ${CHAT_IN / 1000}K tokens in + ${CHAT_OUT} out. Cached input is cheaper, so real use usually stretches further.`,
  });
  box.replaceChildren(head, tabs, out, note);
}
