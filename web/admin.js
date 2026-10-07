// Operator page: balance + orders from /admin, one-click withdraw. The key lives in the URL hash
// (#key=…), which the browser never sends to the server, so it doesn't end up in access logs.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let key = new URLSearchParams(location.hash.slice(1)).get('key') ?? '';
const q = () => `key=${encodeURIComponent(key)}`;

async function load() {
  if (!key) return ($('#login').hidden = false);
  const r = await fetch(`/admin?${q()}`);
  if (r.status === 403) {
    key = ''; // stop polling with a wrong key
    $('#login').hidden = false;
    $('#key').placeholder = 'wrong key — ADMIN_KEY';
    return;
  }
  const a = await r.json();
  $('#login').hidden = true;
  $('#wallet').hidden = false;
  $('#mint').textContent = a.mint;
  $('#balance').textContent = a.balance.toLocaleString();
  $('#withdraw').disabled = a.balance === 0;
  // key pool (FIAT): what the shop can still sell; it stops selling an amount when amount + reserve > available − pending
  const f = (x) => `${x.toFixed(2)} ${esc(a.fiat.toUpperCase())}`;
  $('#pool').hidden = !a.pool;
  if (a.pool) {
    const left = a.pool.available - a.pool.pending;
    $('#pool').innerHTML = `Key pool: <b class="${left < a.pool.alert ? 'bad' : ''}">${f(left)}</b> left to sell
      (pool user ${f(a.pool.quota)} − sold keys hold ${f(a.pool.owed)} − open orders ${f(a.pool.pending)}; reserve ${a.pool.reserve}, alert below ${a.pool.alert})`;
  }
  const refunds = a.orders.filter((o) => o.topup?.needsRefund);
  $('#refunds').hidden = refunds.length === 0;
  $('#refunds').textContent = `Needs refund (top-up paid, key gone): ${refunds.map((o) => `${o.id} ${o.money} ${o.fiat.toUpperCase()} ${o.paid?.sats} sat`).join(' · ')}`;
  const time = (t) => new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('#orders').innerHTML = a.orders.slice().reverse().slice(0, 30).map((o) => `<tr>
    <td class="muted">${time(o.createdAt)}</td><td>${o.kind === 'keytopup' ? '🔋 ' : o.kind === 'key' ? '🔑 ' : ''}${esc(o.money)} ${esc(o.fiat.toUpperCase())}</td>
    <td>${o.paid ? `${o.paid.sats} sat ${o.paid.via === 'cashu' ? '🥜' : '⚡'}` : `<span class="muted">${o.sats} sat</span>`}</td>
    <td class="${o.state === 'PAID' ? 'ok' : 'muted'}">${esc(o.state)}${o.paid && !o.notify.done ? ' · notify…' : ''}${o.topup?.needsRefund ? ' · needs refund' : ''}</td></tr>`).join('');
}

$('#go').addEventListener('click', () => {
  key = $('#key').value.trim();
  location.hash = 'key=' + encodeURIComponent(key);
  load();
});

$('#withdraw').addEventListener('click', async () => {
  const btn = $('#withdraw');
  if (!confirm(`Withdraw ${$('#balance').textContent} sat as one ecash token?`)) return;
  btn.disabled = true;
  $('#err').hidden = true;
  try {
    const r = await fetch(`/admin/withdraw?${q()}`, { method: 'POST' });
    const w = await r.json();
    if (!r.ok) throw new Error(w.error);
    $('#out').hidden = false;
    $('#out-sats').textContent = w.sats.toLocaleString();
    // the gateway only returns the token when WITHDRAW_TOKEN_OVER_HTTP=1; otherwise it's in the file only
    $('#out-token').hidden = !w.token;
    $('#token').value = w.token ?? '';
    $('#out-file').hidden = false;
    $('#out-file').textContent = w.token ? `Also saved on the gateway: ${w.file}` : `Saved on the gateway host: ${w.file} (copy it from there)`;
  } catch (e) {
    $('#err').hidden = false;
    $('#err').textContent = e.message;
  }
  load();
});

// navigator.clipboard only exists on https/localhost and may still be denied; fall back to execCommand.
$('#copy').addEventListener('click', async () => {
  const box = $('#token');
  try {
    await navigator.clipboard.writeText(box.value);
  } catch {
    box.select();
    document.execCommand('copy');
  }
  $('#copy').textContent = 'Copied ✓';
});

load();
setInterval(load, 3000);
