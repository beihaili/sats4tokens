// Checkout page: polls /api/order/:id, shows the lightning invoice or takes a pasted cashu token.
import { renderModels } from '/models.js?v=2';
const id = location.pathname.split('/').pop();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let shownInvoice = '';
let payError = '';
let redirectTimer = 0;

function render(o) {
  $('#order').innerHTML = `
    <div class="muted">${esc(o.name)} · order <span class="mono">${esc(o.kind === 'key' ? o.id.slice(0, 10) + '…' : o.id)}</span></div>
    <div class="amount">${o.sats.toLocaleString()} <small>sat</small></div>
    <div class="muted">= ${esc(o.money)} ${esc(o.fiat.toUpperCase())} · 1 BTC = ${o.btcPrice.toLocaleString()} ${esc(o.fiat.toUpperCase())}</div>`;
  $('#mint').textContent = o.mint;

  if (o.state === 'PAID' && o.kind === 'key') {
    // key shop: no merchant to go back to — the key itself is the product
    $('#pay').hidden = true;
    $('#done').hidden = false;
    $('#back').hidden = true;
    $('#done-detail').textContent = o.apiKey
      ? `${o.paid.sats} sat received via ${o.paid.via}.`
      : `${o.paid.sats} sat received via ${o.paid.via}. Creating your key…${o.keyError ? ' (retrying: ' + o.keyError + ')' : ''}`;
    if (o.apiKey && $('#key').hidden) {
      $('#key').hidden = false;
      startUsage();
      // Claude Code speaks the Anthropic API: root URL (it adds /v1/messages). new-api reserves quota for
      // max_tokens up front, so cap the output or a $1 key is refused before the first call.
      const root = o.apiKey.baseUrl.replace(/\/v1$/, '');
      $('#claude').value = `ANTHROPIC_BASE_URL=${root} \\\n  ANTHROPIC_AUTH_TOKEN=${o.apiKey.key} \\\n  ANTHROPIC_MODEL=claude-opus-4-8 ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-opus-4-6 \\\n  CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \\\n  claude`;
      $('#prices').hidden = false;
      renderModels($('#models'));
      $('#env').value = `OPENAI_BASE_URL=${o.apiKey.baseUrl}\nOPENAI_API_KEY=${o.apiKey.key}`;
      $('#curl').value = `curl ${o.apiKey.baseUrl}/chat/completions \\\n  -H "Authorization: Bearer ${o.apiKey.key}" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'`;
    }
    return;
  }
  if (o.state === 'PAID') {
    $('#pay').hidden = true;
    $('#done').hidden = false;
    $('#done-detail').textContent = `${o.paid.sats} sat received via ${o.paid.via}. Your balance is being credited.`;
    $('#back').hidden = !o.returnUrl;
    $('#back').href = o.returnUrl;
    if (o.returnUrl && !redirectTimer) redirectTimer = setTimeout(() => (location.href = o.returnUrl), 5000);
    return;
  }
  if (o.state === 'EXPIRED') {
    $('#pay').hidden = true;
    $('#order').insertAdjacentHTML('beforeend', '<p class="bad">This order expired. Go back and start a new top-up.</p>');
    return;
  }
  $('#pay').hidden = false;
  // first render picks the tab: #cashu / #ln in the URL wins, else the gateway's CHECKOUT_TAB
  if (!tabShown) showTab(location.hash === '#cashu' ? 'cashu' : location.hash === '#ln' ? 'ln' : o.tab);
  $('#tab-ln').classList.toggle('loading', !o.invoice);
  if (o.invoice && o.invoice !== shownInvoice) {
    shownInvoice = o.invoice;
    $('#qr').src = `/api/order/${id}/qr.svg`;
    $('#ln-link').href = 'lightning:' + o.invoice;
    $('#invoice').value = o.invoice;
  }
  const err = o.lastError ?? payError; // payError: the last pasted token's rejection, kept across polls
  $('#err').hidden = !err;
  $('#err').textContent = err ?? '';
  const left = Math.max(0, Math.round((o.expiresAt - Date.now()) / 1000));
  $('#countdown').textContent = o.state === 'SETTLING' ? '(settling with the mint…)' : `(${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left)`;
}

async function poll() {
  try {
    const r = await fetch(`/api/order/${id}`);
    if (!r.ok) throw new Error((await r.json()).error);
    render(await r.json());
  } catch (e) {
    $('#order').innerHTML = `<p class="bad">${esc(e.message)}</p>`;
  }
}

// The invoice is created only when the Lightning tab is shown (cashu payers never get one).
let invoiceAsked = false;
let tabShown = false;
function showTab(tab) {
  tabShown = true;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
  $('#tab-ln').hidden = tab !== 'ln';
  $('#tab-cashu').hidden = tab !== 'cashu';
  if (tab === 'ln' && !invoiceAsked) {
    invoiceAsked = true;
    fetch(`/api/order/${id}/invoice`, { method: 'POST' }).then(poll);
  }
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
// navigator.clipboard only exists on https/localhost (and may be denied); the demo runs on plain http,
// so fall back to execCommand.
async function copyBox(box) {
  try {
    await navigator.clipboard.writeText(box.value);
  } catch {
    box.select();
    document.execCommand('copy');
  }
}
$('#copyenv').addEventListener('click', () => copyBox($('#env')));
$('#copyclaude').addEventListener('click', () => copyBox($('#claude')));

// key shop: what the key has spent (balance + latest calls), refreshed every 10s while the key is shown
const usd = (x) => '$' + Number(x.toFixed(6)); // $0.997648, $0.002352, $0 — small calls stay visible
let usageTimer;
async function loadUsage() {
  const r = await fetch(`/api/order/${id}/usage`);
  const u = await r.json();
  if (!r.ok) {
    $('#balance').textContent = `(${u.error})`;
    return;
  }
  $('#balance').textContent = `${usd(u.remainingUsd)} left · ${usd(u.usedUsd)} used · ${u.totalCalls} call${u.totalCalls === 1 ? '' : 's'}`;
  $('#nocalls').hidden = u.calls.length > 0;
  $('#calls').hidden = u.calls.length === 0;
  $('#calls tbody').replaceChildren(
    ...u.calls.map((c) => {
      const tr = document.createElement('tr');
      const cells = [new Date(c.time * 1000).toLocaleTimeString(), c.model, `${c.promptTokens} / ${c.completionTokens}`, usd(c.costUsd)];
      for (const v of cells) tr.append(Object.assign(document.createElement('td'), { textContent: v }));
      return tr;
    }),
  );
}
function startUsage() {
  if (usageTimer) return;
  loadUsage();
  usageTimer = setInterval(loadUsage, 10_000);
}
$('#refresh').addEventListener('click', loadUsage);
$('#copy').addEventListener('click', async () => {
  const box = $('#invoice');
  try {
    await navigator.clipboard.writeText(box.value);
  } catch {
    box.select();
    document.execCommand('copy');
  }
});
async function payWithToken() {
  const btn = $('#paytoken');
  if (btn.disabled) return; // a payment is already in flight
  btn.disabled = true;
  btn.textContent = 'Paying…';
  payError = '';
  try {
    const r = await fetch(`/api/order/${id}/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: $('#token').value }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    render(j);
  } catch (e) {
    payError = e.message;
    $('#err').hidden = false;
    $('#err').textContent = payError;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Pay with token';
  }
}
$('#paytoken').addEventListener('click', payWithToken);
// Pasting a whole token pays right away (one step less on stage). Typing never matches, so no surprise submits.
let autoPaid = '';
$('#token').addEventListener('input', () => {
  const v = $('#token').value.trim().replace(/^cashu:/i, '');
  if (/^cashu[AB][A-Za-z0-9_\-+/=]{40,}$/.test(v) && v !== autoPaid) {
    autoPaid = v; // the same token is auto-submitted once; after an error the button still works
    payWithToken();
  }
});

poll();
setInterval(poll, 1500);
