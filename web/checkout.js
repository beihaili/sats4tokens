// Checkout page: polls /api/order/:id, shows the lightning invoice or takes a pasted cashu token.
const id = location.pathname.split('/').pop();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let shownInvoice = '';
let redirectTimer = 0;

function render(o) {
  $('#order').innerHTML = `
    <div class="muted">${esc(o.name)} · order <span class="mono">${esc(o.id)}</span></div>
    <div class="amount">${o.sats.toLocaleString()} <small>sat</small></div>
    <div class="muted">= ${esc(o.money)} ${esc(o.fiat.toUpperCase())} · 1 BTC = ${o.btcPrice.toLocaleString()} ${esc(o.fiat.toUpperCase())}</div>`;
  $('#mint').textContent = o.mint;

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
  $('#tab-ln').classList.toggle('loading', !o.invoice);
  if (o.invoice && o.invoice !== shownInvoice) {
    shownInvoice = o.invoice;
    $('#qr').src = `/api/order/${id}/qr.svg`;
    $('#ln-link').href = 'lightning:' + o.invoice;
    $('#invoice').value = o.invoice;
  }
  $('#err').hidden = !o.lastError;
  $('#err').textContent = o.lastError ?? '';
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
function showTab(tab) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
  $('#tab-ln').hidden = tab !== 'ln';
  $('#tab-cashu').hidden = tab !== 'cashu';
  if (tab === 'ln' && !invoiceAsked) {
    invoiceAsked = true;
    fetch(`/api/order/${id}/invoice`, { method: 'POST' }).then(poll);
  }
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#copy').addEventListener('click', () => navigator.clipboard.writeText($('#invoice').value));
$('#paytoken').addEventListener('click', async () => {
  const btn = $('#paytoken');
  btn.disabled = true;
  btn.textContent = 'Paying…';
  try {
    const r = await fetch(`/api/order/${id}/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: $('#token').value }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    render(j);
  } catch (e) {
    $('#err').hidden = false;
    $('#err').textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Pay with token';
  }
});

showTab(location.hash === '#cashu' ? 'cashu' : 'ln');
poll();
setInterval(poll, 1500);
