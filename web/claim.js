// Trial key for bitcoin holders: address → message to sign (from the gateway) → signature → a paid key order, whose
// /pay/ page shows the key. The gateway checks the signature and the address's coins at its snapshot block.
import { USES, savePlan, CC_DEFAULT, CODEX_DEFAULT, CHAT_DEFAULT } from '/setup.js?v=2';
const $ = (s) => document.querySelector(s);

// "Where will you use it?": saved as the homepage's plan (`s4t-plan`), so the key page opens on that client's setup
// with its default model, exactly as after a purchase from the homepage.
const modelFor = (use) => (use === 'claude-code' ? CC_DEFAULT : use === 'codex' ? CODEX_DEFAULT : CHAT_DEFAULT);
let use = 'claude-code';
function renderUses() {
  $('#uses').replaceChildren(...USES.map((u) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: u.name, title: u.sub });
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(u.id === use));
    b.classList.toggle('on', u.id === use);
    b.onclick = () => ((use = u.id), renderUses());
    return b;
  }));
  const u = USES.find((x) => x.id === use);
  $('#use-hint').textContent = `${u.sub}. Your key page will open with this setup, on ${modelFor(use)}. The key works with every model.`;
}
const remember = () => savePlan({ use, model: modelFor(use) });
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
  // the threshold is the operator's setting (PROOF_MIN_SATS): the page never hard-codes it
  $('#tagline').textContent = `Sign a message with an address that holds ${btc} BTC, get a free AI API key. No account, no KYC.`;
  $('#rules').innerHTML = `
    <ol class="steps">
      <li>An address that held at least <b>${btc} BTC</b> (${r.minSats.toLocaleString('en')} sat) at block
        <b>${r.snapshot.toLocaleString('en')}</b>, in coins it still holds now.</li>
      <li>Sign one message with it. You get a key worth <b>$${r.grantUsd}</b>, for any model on the list.</li>
      <li>One key per address. <b>${r.left}</b> of ${r.total} keys left${r.leftToday < r.left ? `, ${r.leftToday} today` : ''}.</li>
    </ol>`;
  if (r.leftToday > 0) {
    renderUses();
    $('#use-card').hidden = false;
    $('#s1').hidden = false;
  }
  else $('#rules').insertAdjacentHTML('beforeend', `<p class="bad">${r.left ? 'Today\'s keys are gone: come back tomorrow.' : 'All trial keys are gone.'}</p>`);
}

/** Message to sign for the address in the box; true if we got one (else the error is shown). */
async function getChallenge() {
  say('');
  $('#get').disabled = true;
  try {
    issued = await post('/api/proof/challenge', { address: $('#addr').value });
    $('#addr').value = issued.address;
    $('#msg').value = issued.message;
    $('#exp').textContent = 'valid until ' + new Date(issued.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('#s2').hidden = false;
    $('#s2').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  } catch (e) {
    issued = undefined;
    $('#s2').hidden = false;
    say(e.message);
    return false;
  } finally {
    $('#get').disabled = false;
  }
}
$('#get').onclick = () => void getChallenge();

// ---- UniSat (browser extension / its app's browser): address → our message → wallet signs → claim, in one click.
// bc1q / bc1p sign BIP-322 simple (the only proof a Taproot address can give); 1… / 3… sign the classic
// "Bitcoin Signed Message" (BIP-137). The gateway accepts both, so nothing here is trusted: it re-checks everything.
const walletSay = (html, bad = true) => {
  $('#wallet-msg').innerHTML = html;
  $('#wallet-msg').className = bad ? 'bad' : 'hint';
  $('#wallet-msg').hidden = !html;
};
$('#unisat-btn').onclick = async () => {
  walletSay('');
  const w = window.unisat; // injected by the extension (or UniSat's in-app browser)
  if (typeof w?.requestAccounts !== 'function' || typeof w?.signMessage !== 'function') {
    return walletSay('UniSat isn\'t installed in this browser. <a href="https://unisat.io/download" target="_blank" rel="noopener">Get UniSat</a>, or sign by hand below.');
  }
  const btn = $('#unisat-btn');
  btn.disabled = true;
  try {
    btn.textContent = 'Connecting to UniSat…';
    const [address] = await w.requestAccounts();
    if (!address) throw new Error('UniSat didn\'t share an address.');
    $('#addr').value = address;
    if (!(await getChallenge())) return;
    btn.textContent = 'Sign the message in UniSat…';
    const type = /^bc1[qp]/i.test(address) ? 'bip322-simple' : 'ecdsa';
    $('#sig').value = await w.signMessage(issued.message, type);
    btn.textContent = 'Checking…';
    await claim();
  } catch (e) {
    walletSay(e?.code === 4001 ? 'You cancelled in UniSat.' : (e?.message || String(e)).replace(/</g, '&lt;'));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect UniSat and sign';
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

$('#claim').onclick = () => void claim();
async function claim() {
  say('');
  if (!issued || !$('#msg').value) return say('Get a message for this address first (step 1).');
  if (!$('#sig').value.trim()) return say('Paste the signature from your wallet.');
  $('#claim').disabled = true;
  $('#claim').textContent = 'Checking the signature and the address…';
  try {
    const { id } = await post('/api/proof/claim', { address: issued.address, message: issued.message, signature: $('#sig').value.trim(), ref });
    remember();
    location.href = '/pay/' + id;
  } catch (e) {
    say(e.message);
    $('#claim').disabled = false;
    $('#claim').textContent = 'Get my trial key';
  }
}

void rules();
