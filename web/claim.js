// Trial key for bitcoin holders: address → message to sign (from the gateway) → signature → a paid key order, whose
// /pay/ page shows the key. The gateway checks the signature and the address's coins at its snapshot block.
const $ = (s) => document.querySelector(s);
const post = async (path, body) => {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
const say = (text) => { $('#error').textContent = text; $('#error').hidden = !text; };

// funnel: same ?ref= memory as the homepage, so trial keys are counted per channel
let ref = new URLSearchParams(location.search).get('ref') || '';
try {
  ref ||= localStorage.getItem('s4t-ref') || '';
  if (ref) localStorage.setItem('s4t-ref', ref);
} catch { /* storage blocked: no ref */ }

let issued; // {address, message, expiresAt}

async function rules() {
  const r = await fetch('/api/proof').then((x) => x.json()).catch(() => ({ enabled: false }));
  if (!r.enabled) {
    $('#rules').innerHTML = 'Trial keys aren\'t on right now. <a href="/">Buy a key from €1 instead →</a>';
    return;
  }
  const btc = (r.minSats / 1e8).toLocaleString('en', { maximumFractionDigits: 8 });
  $('#rules').innerHTML = `
    <ol class="steps">
      <li>An address that held at least <b>${btc} BTC</b> (${r.minSats.toLocaleString('en')} sat) at block
        <b>${r.snapshot.toLocaleString('en')}</b>, in coins it still holds now.</li>
      <li>Sign one message with it. You get a key worth <b>$${r.grantUsd}</b>, for any model on the list.</li>
      <li>One key per address. <b>${r.left}</b> of ${r.total} keys left${r.leftToday < r.left ? `, ${r.leftToday} today` : ''}.</li>
    </ol>`;
  if (r.leftToday > 0) $('#s1').hidden = false;
  else $('#rules').insertAdjacentHTML('beforeend', `<p class="bad">${r.left ? 'Today\'s keys are gone: come back tomorrow.' : 'All trial keys are gone.'}</p>`);
}

$('#get').onclick = async () => {
  say('');
  $('#get').disabled = true;
  try {
    issued = await post('/api/proof/challenge', { address: $('#addr').value });
    $('#addr').value = issued.address;
    $('#msg').value = issued.message;
    $('#exp').textContent = 'valid until ' + new Date(issued.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#s2').hidden = false;
    $('#s2').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    $('#s2').hidden = false;
    say(e.message);
  } finally {
    $('#get').disabled = false;
  }
};
$('#addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#get').click(); });
// a changed address needs a new message
$('#addr').addEventListener('input', () => { if (issued && $('#addr').value.trim().toLowerCase() !== issued.address.toLowerCase()) $('#msg').value = ''; });

$('#copy-msg').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('#msg').value);
  } catch {
    $('#msg').select();
    document.execCommand('copy');
  }
  $('#copy-msg').textContent = 'Copied ✓';
  setTimeout(() => ($('#copy-msg').textContent = 'Copy message'), 1500);
};

$('#claim').onclick = async () => {
  say('');
  if (!issued || !$('#msg').value) return say('Get a message for this address first (step 1).');
  if (!$('#sig').value.trim()) return say('Paste the signature from your wallet.');
  $('#claim').disabled = true;
  $('#claim').textContent = 'Checking the signature and the address…';
  try {
    const { id } = await post('/api/proof/claim', { address: issued.address, message: issued.message, signature: $('#sig').value.trim(), ref });
    location.href = '/pay/' + id;
  } catch (e) {
    say(e.message);
    $('#claim').disabled = false;
    $('#claim').textContent = 'Get my trial key';
  }
};

void rules();
