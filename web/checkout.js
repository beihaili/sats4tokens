// Checkout page: polls /api/order/:id, shows the lightning invoice or takes a pasted cashu token.
import { renderModels, money } from '/models.js?v=5';
const id = location.pathname.split('/').pop();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let shownInvoice = '';
let payError = '';
let redirectTimer = 0;

function render(o) {
  if (o.state === 'PAID' || o.state === 'EXPIRED') stopScan(); // the pay card is hidden from here on
  $('#order').innerHTML = `
    <div class="muted">${esc(o.name)} · order <span class="mono">${esc(o.kind ? o.id.slice(0, 10) + '…' : o.id)}</span></div>
    <div class="amount">${o.sats.toLocaleString()} <small>sat</small></div>
    <div class="muted">= ${esc(o.money)} ${esc(o.fiat.toUpperCase())} · 1 BTC = ${o.btcPrice.toLocaleString()} ${esc(o.fiat.toUpperCase())}</div>`;
  $('#mint').textContent = o.mint;

  if (o.state === 'PAID' && o.kind === 'keytopup') {
    // a top-up page may be a friend's who pays for you: it never shows the key or links to the key's page
    $('#pay').hidden = true;
    $('#done').hidden = false;
    $('#back').hidden = true;
    const t = o.topup;
    $('#done-detail').textContent = `${o.paid.sats} sat received via ${o.paid.via}. ` + (t.applied
      ? `Added ${money(Number(o.money), o.fiat)} to key ${t.key} · its balance is now ${money(t.applied.remaining, o.fiat, 2)}.`
      : t.needsRefund
        ? `Key ${t.key} no longer exists, so nothing was added. You get the money back: keep this page's URL (don't post it publicly) and contact us.`
        : `Adding it to key ${t.key}…${o.keyError ? ' (retrying: ' + o.keyError + ')' : ''}`);
    return;
  }
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
      // max_tokens up front, so cap the output or a small key is refused before the first call.
      const root = o.apiKey.baseUrl.replace(/\/v1$/, '');
      $('#claude').value = `ANTHROPIC_BASE_URL=${root} \\\n  ANTHROPIC_AUTH_TOKEN=${o.apiKey.key} \\\n  ANTHROPIC_MODEL=claude-opus-4-8 ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-opus-4-6 \\\n  CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \\\n  claude`;
      $('#prices').hidden = false;
      renderModels($('#models'));
      $('#env').value = `OPENAI_BASE_URL=${o.apiKey.baseUrl}\nOPENAI_API_KEY=${o.apiKey.key}`;
      showTopup(o.apiKey.key);
      setupAuto(o.apiKey.key, o.auto, o.fiat);
      $('#curl').value = `curl ${o.apiKey.baseUrl}/chat/completions \\\n  -H "Authorization: Bearer ${o.apiKey.key}" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'`;
    }
    renderTopups(o.topups ?? []);
    renderAuto(o.auto);
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
    const again = o.kind === 'keytopup' ? 'Start a new top-up from the key\'s page.' : o.kind === 'key' ? '<a href="/">Start a new order</a>.' : 'Go back and start a new top-up.';
    $('#order').insertAdjacentHTML('beforeend', `<p class="bad">This order expired. ${again}</p>`);
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
  if (tab !== 'cashu') stopScan();
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
const cash = (x, fiat) => money(x, fiat, 6); // €0.997648, €0.002352, €0 — small calls stay visible
let usageTimer;
async function loadUsage() {
  const r = await fetch(`/api/order/${id}/usage`);
  const u = await r.json();
  if (!r.ok) {
    $('#balance').textContent = `(${u.error})`;
    return;
  }
  $('#balance').textContent = `${cash(u.remaining, u.fiat)} left · ${cash(u.used, u.fiat)} used · ${u.totalCalls} call${u.totalCalls === 1 ? '' : 's'}`;
  // a spent key answers 403 "quota exhausted": point at the top-up buttons before that happens
  const low = u.remaining <= 0.1 * (u.used + u.remaining);
  $('#low').hidden = !low;
  if (low) $('#low').innerHTML = `${u.remaining > 0 ? 'Running low.' : 'This key is used up.'} <a href="#topup">Top it up ↓</a>`;
  $('#nocalls').hidden = u.calls.length > 0;
  $('#calls').hidden = u.calls.length === 0;
  $('#calls tbody').replaceChildren(
    ...u.calls.map((c) => {
      const tr = document.createElement('tr');
      const cells = [new Date(c.time * 1000).toLocaleTimeString(), c.model, `${c.promptTokens} / ${c.completionTokens}`, cash(c.cost, u.fiat)];
      for (const v of cells) tr.append(Object.assign(document.createElement('td'), { textContent: v }));
      return tr;
    }),
  );
}
// Top-up buttons under the usage: a new order for this key (its page shows only the key's last 4 characters, so the
// link can go to someone else to pay). Amounts come from /api/shop, which leaves out what the pool can't sell now.
async function showTopup(key) {
  const shop = await (await fetch('/api/shop')).json().catch(() => ({}));
  const msg = (t) => {
    $('#topup-msg').hidden = !t;
    $('#topup-msg').textContent = t ?? '';
  };
  if (!shop.enabled || shop.soldOut) return msg('Top-ups are paused right now (we are refilling). Try again later.');
  $('#topup-amounts').replaceChildren(
    ...shop.amounts.map((a) => {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = `+ ${money(Number(a), shop.fiat)}`;
      if (shop.sats?.[a]) b.append(Object.assign(document.createElement('small'), { textContent: `≈ ${shop.sats[a].toLocaleString('en')} sat` }));
      b.onclick = async () => {
        b.disabled = true;
        const r = await fetch('/api/buy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ money: a, key }) });
        const j = await r.json();
        if (!r.ok) {
          b.disabled = false;
          return msg(j.error);
        }
        location.href = `/pay/${j.id}`;
      };
      return b;
    }),
  );
  msg('Pays like the key did. The top-up page never shows the key, so you can send its link to someone else to pay.');
}
// Auto top-up (NWC): the form saves to /api/autotopup with the key as authorization; the order poll brings its state
// (never the connection string). Settings are copied into the form once; the textarea stays empty after saving.
let autoKey = '';
let autoFiat = '';
let autoFilled = false;
function setupAuto(key, a, fiat) {
  autoKey = key;
  autoFiat = fiat;
  const amounts = ['1', '2', '5', '10']; // the shop's amounts (KEY_AMOUNTS)
  $('#auto-money').replaceChildren(...amounts.map((x) => Object.assign(document.createElement('option'), { value: x, textContent: money(Number(x), fiat) })));
  $('#auto-money').value = '2';
  renderAuto(a);
  $('#auto-save').onclick = () => saveAuto({
    nwc: $('#auto-nwc').value.trim() || undefined,
    money: $('#auto-money').value, below: Number($('#auto-below').value), perDay: Number($('#auto-perday').value),
  });
  $('#auto-off').onclick = () => saveAuto({ off: true });
}
async function saveAuto(body) {
  const msg = $('#auto-msg');
  msg.hidden = true;
  $('#auto-save').disabled = true;
  try {
    const r = await fetch('/api/autotopup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: autoKey, ...body }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    $('#auto-nwc').value = '';
    autoFilled = false;
    renderAuto(j.auto);
  } catch (e) {
    msg.hidden = false;
    msg.textContent = e.message;
  } finally {
    $('#auto-save').disabled = false;
  }
}
function renderAuto(a) {
  if (!autoKey) return;
  $('#auto-off').hidden = !a;
  $('#auto-save').textContent = a ? (a.paused ? 'Save and resume' : 'Save settings') : 'Turn on auto top-up';
  $('#auto-nwc').placeholder = a ? `Connected: wallet ${a.wallet} via ${a.relay}. Paste a new connection to replace it.` : 'nostr+walletconnect://…';
  if (a && !autoFilled) {
    autoFilled = true;
    $('#auto-money').value = a.money;
    $('#auto-below').value = a.below;
    $('#auto-perday').value = a.perDay;
  }
  if (!a) return void ($('#auto-state').textContent = 'Off. Never run dry: let your own wallet top this key up when it gets low.');
  const m = (x) => money(Number(x), autoFiat, 2);
  const last = a.last
    ? ` Last: ${new Date(a.last.at).toLocaleString()}, +${m(a.last.money)}, ${a.last.applied ? 'added ✓' : a.last.outcome === 'declined' ? 'wallet did not pay' : a.last.state === 'EXPIRED' ? 'not paid' : 'in progress…'}.`
    : '';
  $('#auto-state').innerHTML = esc(a.paused
    ? `Paused after ${a.failures} failed tries${a.lastError ? ` (${a.lastError})` : ''}. Fix it in your wallet, then save again to resume.`
    : `On: +${m(a.money)} when below ${m(a.below)}, at most ${m(a.perDay)} a day (${m(a.spent24h)} in the last 24 h).${a.lastError ? ` Note: ${a.lastError}.` : ''}${last}`);
}

let shownTopups = '';
function renderTopups(list) {
  const s = JSON.stringify(list);
  if (s === shownTopups) return;
  shownTopups = s;
  $('#topups').hidden = list.length === 0;
  $('#topups').replaceChildren(
    ...list.map((t) => Object.assign(document.createElement('li'), {
      textContent: `${new Date(t.at).toLocaleString()} · +${money(Number(t.money), t.fiat)}${t.applied ? '' : t.needsRefund ? ' · not added (key was gone)' : ' · adding…'}`,
    })),
  );
  if (list.some((t) => t.applied)) loadUsage(); // a top-up just landed: show the new balance now
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

// ---- camera QR scan (cashu tab). BarcodeDetector where the browser has it (Chrome on Android/macOS), else the
// vendored jsQR (Safari, Firefox). Wallets show tokens with >2 proofs (any 1 € or $ key) as an animated NUT-16 QR
// (ur:bytes/… fountain-coded frames, cashu.me: 150 bytes per frame, a new frame every 150ms); those frames go to
// the vendored bc-ur decoder until the token is complete. Both vendor scripts load on first use. Needs https.
const TOKEN_RE = /cashu[AB][A-Za-z0-9_\-+/=]{40,}/; // also finds it inside "cashu:…" or a wallet link
let cam = null; // { stream, timer, ur } while scanning; ur = the animated-QR decoder once a ur: frame was seen
function scanMsg(text) {
  $('#scanmsg').hidden = !text;
  $('#scanmsg').textContent = text ?? '';
}
function stopScan() {
  if (!cam) return;
  clearTimeout(cam.timer);
  cam.stream.getTracks().forEach((t) => t.stop());
  cam = null;
  $('#cam').hidden = true;
  $('#cam').srcObject = null;
  $('#scan').textContent = '📷 Scan QR';
  scanMsg('');
}
const loaded = {};
/** Load a vendored classic script once; resolves to the global it defines. */
function loadVendor(file, global) {
  loaded[file] ??= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = `/vendor/${file}`;
    s.onload = () => ok(window[global]);
    s.onerror = () => {
      delete loaded[file]; // allow a retry
      fail(new Error(`${file} failed to load`));
    };
    document.head.append(s);
  });
  return loaded[file];
}
/** Returns { name, decode: async (video) => string|null } reading one QR from the current frame. */
async function makeDecoder() {
  if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
    const d = new BarcodeDetector({ formats: ['qr_code'] });
    return { name: 'native', decode: async (v) => (await d.detect(v))[0]?.rawValue ?? null };
  }
  const jsQR = await loadVendor('jsQR.js', 'jsQR');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let crop = false;
  return {
    name: 'jsQR',
    decode: async (v) => {
      // jsQR is pure JS, so frames are capped at 960px. Odd frames: the whole picture, downscaled. Even frames: the
      // centre square at full resolution, where a phone held up to the camera usually is, so dense QRs keep their detail.
      const w = v.videoWidth, h = v.videoHeight;
      const side = Math.min(w, h) * 0.8;
      const [sx, sy, sw, sh] = (crop = !crop) ? [(w - side) / 2, (h - side) / 2, side, side] : [0, 0, w, h];
      const k = Math.min(1, 960 / Math.max(sw, sh));
      canvas.width = Math.round(sw * k);
      canvas.height = Math.round(sh * k);
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
    },
  };
}
/** Pay with the token found in `text`. Returns true if there was one. */
function payScanned(text) {
  let t = text.trim();
  try { t = decodeURIComponent(t); } catch { /* not URI-encoded */ }
  const m = t.match(TOKEN_RE);
  if (!m) return false;
  stopScan();
  $('#token').value = m[0];
  autoPaid = m[0];
  payWithToken();
  return true;
}
/** Handle one decoded QR. Returns true when scanning is done (a token was found and is being paid). */
async function onScanned(text) {
  if (/^ur:/i.test(text)) {
    const scan = cam;
    if (!scan.ur) {
      scan.ur = 'loading';
      try {
        const BCUR = await loadVendor('bcur.js', 'BCUR');
        if (cam === scan) scan.ur = BCUR.makeURDecoder();
      } catch (e) {
        if (cam === scan) scan.ur = null;
        scanMsg(`${e.message}. Paste the token instead.`);
        return false;
      }
    }
    if (cam !== scan || scan.ur === 'loading') return false; // frames while the decoder loads are skipped
    let out = null;
    try {
      out = scan.ur.receive(text);
    } catch {
      // all frames in but the result doesn't check out (misread frames are skipped inside): collect again
      scan.ur = null;
      scanMsg('Animated QR: decoding failed, starting over…');
      return false;
    }
    if (out) {
      if (payScanned(out)) return true;
      scan.ur = null;
      scanMsg('That animated QR is not a Cashu token.');
      return false;
    }
    scanMsg(`Animated QR: ${Math.round(scan.ur.progress() * 100)}% · keep holding it steady…`);
    return false;
  }
  if (payScanned(text)) return true;
  if (/^(lightning:)?ln(bc|tb)/i.test(text)) scanMsg('That is a Lightning invoice. Show the QR of a Cashu token (cashuA…/cashuB…).');
  else scanMsg('Not a Cashu token. Show the QR of a cashuA…/cashuB… token.');
  return false;
}
async function startScan() {
  if (!navigator.mediaDevices?.getUserMedia) return scanMsg('The camera needs https. Paste the token instead.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) {
    return scanMsg(e.name === 'NotAllowedError' ? 'Camera permission denied. Paste the token instead.'
      : e.name === 'NotFoundError' ? 'No camera found. Paste the token instead.' : `Camera error: ${e.message}`);
  }
  if ($('#pay').hidden || $('#tab-cashu').hidden) return stream.getTracks().forEach((t) => t.stop()); // left the tab meanwhile
  const track = stream.getVideoTracks()[0];
  track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}); // where supported (Android)
  cam = { stream, timer: 0, ur: null };
  const v = $('#cam');
  v.srcObject = stream;
  v.hidden = false;
  // a laptop or selfie camera: mirror the preview so moving the phone feels natural (decoding uses the raw frames)
  v.classList.toggle('mirror', track.getSettings().facingMode !== 'environment');
  $('#scan').textContent = 'Stop camera';
  scanMsg('Hold the token’s QR in front of the camera.');
  await v.play().catch(() => {});
  let dec;
  try {
    dec = await makeDecoder();
  } catch (e) {
    stopScan();
    return scanMsg(`${e.message}. Paste the token instead.`);
  }
  const mine = cam;
  if (mine) scanMsg(`Hold the token’s QR in front of the camera. (${dec.name}, ${v.videoWidth}×${v.videoHeight})`);
  const tick = async () => {
    if (cam !== mine) return; // stopped (or restarted) while decoding
    let text = null;
    if (v.readyState >= 2) text = await dec.decode(v).catch(() => null);
    if (cam !== mine) return;
    if (text && (await onScanned(text))) return;
    if (cam !== mine) return;
    // animated QRs change frame every ~150ms, so read often; one decode is a few ms native, tens of ms in jsQR
    cam.timer = setTimeout(tick, 40);
  };
  tick();
}
$('#scan').addEventListener('click', () => (cam ? stopScan() : startScan()));
window.addEventListener('pagehide', stopScan);

poll();
setInterval(poll, 1500);
