// /network: Sats4Tokens as one node, its upstream providers and their channels fanned out above it, and requests
// flying to the channel that served them.
//   • real requests: /api/network → `recent` (calls made with sold keys, mapped to anonymized nodes), polled every 5s
//   • route preview: between real calls, requests are sampled from the real routing table with new-api's rule
//     (highest priority tier, by weight inside it; now and then the primary "fails" and the next tier answers).
//     Drawn lighter and labelled, so nobody mistakes it for traffic.
const SVGNS = 'http://www.w3.org/2000/svg';
const W = 1000;
const H = 640;
const HUB = { x: 500, y: 512 };
const YOU = { x: 500, y: 608 };
const R_PROV = 250; // providers on this arc around the hub
const R_NODE = [372, 438]; // their channels on two staggered arcs further out
const A_LEFT = 172; // degrees: the fan spans from the left (172°) to the right (8°) above the hub
const A_RIGHT = 8;
const POLL_MS = 5000;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (x) => `${Math.round(x * 100)}%`;
const polar = (deg, r) => ({ x: HUB.x + r * Math.cos((deg * Math.PI) / 180), y: HUB.y - r * Math.sin((deg * Math.PI) / 180) });

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
}

/** e.g. "12s ago", "5 min ago", "3 h ago", else the date. */
function ago(unix) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(unix * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ------------------------------------------------------------------ state

let net; // the last /api/network reply
let drawnAt; // generatedAt of the snapshot on screen
const nodes = new Map(); // name → { node, provider, pos, g, roles }
const provs = new Map(); // name → { pos, g }
const edges = new Map(); // "hub>A", "A>A1", "you>hub" → line
let selected = ''; // model filter ('' = all)

/** For each node: models it is primary for, models it is a failover for. */
function roles(routes) {
  const r = new Map();
  const get = (n) => r.get(n) ?? r.set(n, { primary: [], failover: [] }).get(n);
  for (const [model, tiers] of Object.entries(routes)) {
    tiers.forEach((tier, i) => tier.forEach((c) => get(c.node)[i ? 'failover' : 'primary'].push(model)));
  }
  return r;
}

// ------------------------------------------------------------------ drawing

function draw() {
  const box = $('#graph');
  box.textContent = '';
  nodes.clear();
  provs.clear();
  edges.clear();
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Sats4Tokens and its upstream providers' }, box);
  const gEdges = el('g', {}, svg);
  const gNodes = el('g', {}, svg);
  svg.flights = el('g', {}, svg); // packets fly above everything
  const R = roles(net.routes);

  // one angular slot per channel, a gap between providers; providers sit at the middle of their slots
  const GAP = 1.2;
  const slots = net.providers.reduce((s, p) => s + p.nodes.length, 0) + GAP * (net.providers.length - 1);
  const step = (A_LEFT - A_RIGHT) / Math.max(slots - 1, 1);
  let a = A_LEFT;
  for (const p of net.providers) {
    const first = a;
    const placed = p.nodes.map((n, i) => {
      const pos = polar(a, R_NODE[i % 2]);
      a -= step;
      return { n, pos };
    });
    const mid = (first + a + step) / 2;
    a -= GAP * step;
    const ppos = polar(mid, R_PROV);
    edges.set(`hub>${p.name}`, el('line', { class: 'edge trunk', x1: HUB.x, y1: HUB.y, x2: ppos.x, y2: ppos.y }, gEdges));

    for (const { n, pos } of placed) {
      edges.set(`${p.name}>${n.name}`, el('line', { class: 'edge', x1: ppos.x, y1: ppos.y, x2: pos.x, y2: pos.y }, gEdges));
      const role = R.get(n.name) ?? { primary: [], failover: [] };
      const state = !n.active ? 'off' : role.primary.length || role.failover.length ? 'on' : 'idle';
      const g = el('g', { class: `node ${state}`, tabindex: 0 }, gNodes);
      el('circle', { cx: pos.x, cy: pos.y, r: 13 }, g);
      el('text', { x: pos.x, y: pos.y }, g).textContent = n.name;
      g.addEventListener('pointerenter', () => tip(n.name));
      g.addEventListener('pointerleave', () => tip());
      g.addEventListener('focus', () => tip(n.name));
      g.addEventListener('blur', () => tip());
      g.addEventListener('click', (e) => (e.stopPropagation(), tip(n.name)));
      nodes.set(n.name, { node: n, provider: p.name, pos, g, roles: role, state });
    }
    const g = el('g', { class: 'prov' }, gNodes);
    el('circle', { cx: ppos.x, cy: ppos.y, r: 21 }, g);
    el('text', { x: ppos.x, y: ppos.y }, g).textContent = p.name;
    el('title', {}, g).textContent = `Provider ${p.name}: ${p.nodes.length} channel${p.nodes.length > 1 ? 's' : ''}`;
    provs.set(p.name, { pos: ppos, g });
  }

  // you → Sats4Tokens
  edges.set('you>hub', el('line', { class: 'edge trunk', x1: YOU.x, y1: YOU.y, x2: HUB.x, y2: HUB.y }, gEdges));
  const you = el('g', { class: 'you' }, gNodes);
  el('circle', { cx: YOU.x, cy: YOU.y, r: 14 }, you);
  el('text', { x: YOU.x + 24, y: YOU.y - 6, class: 'lbl' }, you).textContent = 'you';
  el('text', { x: YOU.x + 24, y: YOU.y + 12, class: 'lbl small' }, you).textContent = 'a key bought with sats · no account';

  const hub = el('g', { class: 'hub' }, gNodes);
  el('circle', { cx: HUB.x, cy: HUB.y, r: 42 }, hub);
  el('image', { href: '/favicon.svg', x: HUB.x - 30, y: HUB.y - 30, width: 60, height: 60 }, hub);
  el('text', { x: HUB.x + 56, y: HUB.y - 4, class: 'lbl big' }, hub).textContent = 'Sats4Tokens';
  el('text', { x: HUB.x + 56, y: HUB.y + 16, class: 'lbl small' }, hub).textContent = 'upstreams see this node, not you';
  el('text', { x: 24, y: 34, class: 'lbl small' }, svg).textContent = `${net.providers.length} upstream providers · names hidden`;

  box.svg = svg;
  box.append(Object.assign(document.createElement('div'), { id: 'tip', className: 'tip', hidden: true }));
  drawnAt = net.generatedAt;
  highlight();
}

/** Tooltip for one node (or hide it). */
function tip(name) {
  const t = $('#tip');
  const x = name && nodes.get(name);
  if (!x) return void (t.hidden = true);
  const { node: n, roles: r, state } = x;
  const status = state === 'off' ? 'switched off' : state === 'idle' ? 'enabled, no model routed here now' : 'in rotation';
  const list = (ms) => ms.map((m) => `<code>${esc(m)}</code>`).join(' ');
  t.innerHTML =
    `<b>${esc(n.name)}</b> · provider ${esc(x.provider)} · ${status}` +
    (n.latencyMs ? `<br><span class="muted">last health check ${(n.latencyMs / 1000).toFixed(1)}s</span>` : '') +
    (r.primary.length ? `<br>Primary for ${list(r.primary)}` : '') +
    (r.failover.length ? `<br>Failover for ${list(r.failover)}` : '') +
    (!r.primary.length && !r.failover.length ? `<br><span class="muted">Models: ${list(n.models)}</span>` : '');
  t.hidden = false;
  const box = $('#graph').getBoundingClientRect();
  const c = x.g.getBoundingClientRect();
  const left = Math.min(Math.max(c.left - box.left + c.width / 2 - 130, 0), box.width - 260);
  const below = c.top - box.top < box.height * 0.45;
  t.style.left = `${left}px`;
  t.style.top = below ? `${c.bottom - box.top + 8}px` : '';
  t.style.bottom = below ? '' : `${box.bottom - c.top + 8}px`;
}

/** Model filter: primary nodes filled, failovers dashed, the rest faded. */
function highlight() {
  const tiers = selected ? net.routes[selected] ?? [] : null;
  const tierOf = new Map();
  tiers?.forEach((t, i) => t.forEach((c) => tierOf.set(c.node, i)));
  const usedProvs = new Set([...tierOf.keys()].map((n) => nodes.get(n)?.provider));
  for (const [name, x] of nodes) {
    const i = tierOf.get(name);
    x.g.classList.toggle('primary', i === 0);
    x.g.classList.toggle('failover', i > 0);
    x.g.classList.toggle('dim', !!tiers && i === undefined);
    edges.get(`${x.provider}>${name}`)?.classList.toggle('dim', !!tiers && i === undefined);
  }
  for (const [name, p] of provs) {
    p.g.classList.toggle('dim', !!tiers && !usedProvs.has(name));
    edges.get(`hub>${name}`)?.classList.toggle('dim', !!tiers && !usedProvs.has(name));
  }
  renderRoute();
}

// ------------------------------------------------------------------ packets

const flights = new Set();
let raf = 0;

/** Move a dot along `pts` in `dur` ms, light the edges it uses, then call `done`. */
function fly(pts, keys, cls, dur, done) {
  const svg = $('#graph').svg;
  if (!svg) return;
  const dot = el('circle', { r: cls.includes('real') ? 7 : 5, class: `pkt ${cls}`, cx: pts[0].x, cy: pts[0].y }, svg.flights);
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  const hot = keys.map((k) => edges.get(k)).filter(Boolean);
  hot.forEach((e) => (e.hot = (e.hot ?? 0) + 1, e.classList.add('hot')));
  flights.add({ dot, pts, lens, total: lens.reduce((a, b) => a + b, 0), start: performance.now(), dur, hot, done });
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame(now) {
  for (const f of flights) {
    const t = Math.min(1, (now - f.start) / f.dur);
    let d = (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2) * f.total; // ease in-out
    let i = 0;
    while (i < f.lens.length - 1 && d > f.lens[i]) d -= f.lens[i++];
    const a = f.pts[i];
    const b = f.pts[i + 1];
    const k = f.lens[i] ? d / f.lens[i] : 1;
    f.dot.setAttribute('cx', a.x + (b.x - a.x) * k);
    f.dot.setAttribute('cy', a.y + (b.y - a.y) * k);
    if (t >= 1) {
      flights.delete(f);
      f.dot.remove();
      f.hot.forEach((e) => --e.hot || e.classList.remove('hot'));
      f.done?.();
    }
  }
  raf = flights.size ? requestAnimationFrame(frame) : 0;
}

function ping(name, cls = '') {
  const x = nodes.get(name);
  if (!x) return;
  const c = el('circle', { cx: x.pos.x, cy: x.pos.y, r: 13, class: `ping ${cls}` }, $('#graph').svg.flights);
  c.addEventListener('animationend', () => c.remove());
  x.g.classList.add(cls === 'fail' ? 'failed' : 'hit');
  clearTimeout(x.hitTimer);
  x.hitTimer = setTimeout(() => x.g.classList.remove('hit', 'failed'), 1300);
}

function label(name, text) {
  const x = nodes.get(name);
  if (!x) return;
  const up = x.pos.y < HUB.y - 300;
  const t = el('text', { x: x.pos.x, y: x.pos.y + (up ? -22 : 30), class: 'callout' }, $('#graph').svg.flights);
  t.textContent = text;
  setTimeout(() => t.remove(), 2600);
}

/** You → Sats4Tokens → provider → channel, and the answer back. `via` = a channel that fails first (preview). */
function request(name, { real = false, model = '', via } = {}) {
  const x = nodes.get(name);
  if (!x || !$('#graph').svg) return;
  const kind = real ? 'real' : 'preview';
  const legTo = (n) => [HUB, provs.get(n.provider).pos, n.pos];
  const keysTo = (n) => [`hub>${n.provider}`, `${n.provider}>${n.node.name}`];
  const arrive = () => {
    ping(name);
    if (real || model) label(name, real ? `${model}` : `${model} · preview`);
    const back = [...legTo(x)].reverse().concat(YOU);
    fly(back, [...keysTo(x), 'you>hub'], `back ${kind}`, 1100);
  };
  const go = () => fly(legTo(x), keysTo(x), kind, 1100, arrive);
  const v = via && nodes.get(via);
  fly([YOU, HUB], ['you>hub'], kind, 450, () => {
    if (!v) return go();
    // failover: the primary errors, Sats4Tokens retries on the next tier
    fly(legTo(v), keysTo(v), kind, 1000, () => {
      ping(via, 'fail');
      label(via, 'failed → retry');
      fly([...legTo(v)].reverse(), keysTo(v), kind, 700, go);
    });
  });
}

/** new-api's pick inside one tier: by share. */
function pick(tier) {
  let r = Math.random();
  for (const c of tier) if ((r -= c.share) < 0) return c.node;
  return tier[tier.length - 1].node;
}

function previewOnce() {
  const models = selected ? [selected] : Object.keys(net.routes);
  const model = models[Math.floor(Math.random() * models.length)];
  const tiers = net.routes[model];
  if (!tiers?.length) return;
  if (tiers.length > 1 && Math.random() < 0.12) return request(pick(tiers[1]), { model, via: pick(tiers[0]) });
  request(pick(tiers[0]), { model: selected ? '' : model });
}

function previewLoop() {
  if (net && $('#preview').checked && !document.hidden && flights.size < 14) previewOnce();
  setTimeout(previewLoop, 900 + Math.random() * 900);
}

// ------------------------------------------------------------------ panels

function renderStats() {
  const all = net.providers.flatMap((p) => p.nodes);
  const R = roles(net.routes);
  const inRotation = all.filter((n) => R.has(n.name)).length;
  const day = net.recent.filter((c) => c.time > Date.now() / 1000 - 86400).length;
  const tile = (b, s) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`;
  $('#stats').innerHTML =
    tile(net.providers.length, 'independent providers') +
    tile(all.length, `upstream channels · ${inRotation} in rotation`) +
    tile(Object.keys(net.routes).length, 'models routed') +
    tile(net.live ? day : '–', net.live ? 'real requests, last 24 h' : 'live feed unavailable');
}

function renderRoute() {
  const box = $('#route');
  if (!selected) {
    $('#route-title').textContent = 'Where a request goes';
    box.innerHTML = '<p class="hint">Pick a model above to see its route: the primary upstream, and where Sats4Tokens retries if it fails. Hover or tap a node for details.</p>';
    return;
  }
  $('#route-title').textContent = selected;
  const tiers = net.routes[selected] ?? [];
  const prov = (n) => nodes.get(n)?.provider;
  box.innerHTML =
    '<ol class="tiers">' +
    tiers
      .map(
        (t, i) =>
          `<li><span class="muted">${i ? `if that fails (${i})` : 'first'}</span> ` +
          t.map((c) => `<b>${esc(c.node)}</b> <span class="muted">provider ${esc(prov(c.node))}${t.length > 1 ? `, ${pct(c.share)}` : ''}</span>`).join(' · ') +
          '</li>',
      )
      .join('') +
    '</ol>' +
    (new Set(tiers.flat().map((c) => prov(c.node))).size > 1
      ? '<p class="hint">The fallback sits at a different provider: one provider going down or cutting us off doesn\'t stop this model.</p>'
      : '<p class="hint">One provider serves this model today.</p>');
}

function renderRecent() {
  const ul = $('#recent');
  if (!net.live) return void (ul.innerHTML = '<li class="muted">The live feed is unavailable right now.</li>');
  if (!net.recent.length) return void (ul.innerHTML = '<li class="muted">No calls yet — buy a key and make one, it shows up here within seconds.</li>');
  ul.innerHTML = net.recent
    .slice(0, 12)
    .map((c) => `<li><span class="muted">${ago(c.time)}</span> <code>${esc(c.model)}</code> → <b>${esc(c.node ?? 'unlisted')}</b></li>`)
    .join('');
}

/** The three claims, with numbers from the routing table itself (so they stay true when it changes). */
function renderWhy() {
  const models = Object.keys(net.routes);
  const primaryProvs = new Map(); // provider → models it is primary for
  for (const m of models) {
    for (const p of new Set(net.routes[m][0].map((c) => nodes.get(c.node)?.provider))) {
      primaryProvs.set(p, (primaryProvs.get(p) ?? 0) + 1);
    }
  }
  const busiest = Math.max(...primaryProvs.values());
  const crossFailover = models.filter((m) => new Set(net.routes[m].flat().map((c) => nodes.get(c.node)?.provider)).size > 1).length;
  $('#why').innerHTML = `
    <p><b>Upstreams see Sats4Tokens, not you.</b> Every request leaves here with our credentials. Behind your key there is no
      account, no email and no card — you paid with bitcoin — so there is nothing about you to pass on. Upstreams do receive what you
      send (that is how the model answers), so keep identifying details out of prompts.</p>
    <p><b>No single upstream sees all the traffic.</b> Requests are split by model over ${primaryProvs.size} providers; the busiest one is
      the first choice for ${busiest} of ${models.length} models. Calls to different models can land at different companies.</p>
    <p><b>No single upstream can cut you off.</b> ${crossFailover} of ${models.length} models have a fallback at another provider. If an
      upstream fails, blocks us or starts misbehaving, the relay retries on the next one and your key keeps working.</p>`;
}

function fillModels() {
  const sel = $('#model');
  const keep = sel.value;
  sel.length = 1;
  for (const m of Object.keys(net.routes)) sel.add(new Option(m, m));
  sel.value = net.routes[keep] ? keep : '';
  selected = sel.value;
}

// ------------------------------------------------------------------ data

const seen = new Set();
let first = true;

async function poll() {
  try {
    const r = await fetch('/api/network', { cache: 'no-store' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    net = j;
    if (drawnAt !== net.generatedAt) {
      fillModels();
      draw();
      renderWhy();
    }
    renderStats();
    renderRecent();
    const fresh = net.recent.filter((c) => !seen.has(c.id));
    fresh.forEach((c) => seen.add(c.id));
    // on load, replay the newest call if it is recent; afterwards every new call flies
    const show = first ? fresh.filter((c) => c.time > Date.now() / 1000 - 600).slice(0, 1) : fresh;
    show.reverse().forEach((c, i) => c.node && setTimeout(() => request(c.node, { real: true, model: c.model }), i * 600));
    first = false;
    $('#live').textContent = net.live ? '● live' : '';
  } catch (e) {
    if (!net) $('#graph').innerHTML = `<p class="bad">Could not load the upstream network: ${esc(e.message)}</p>`;
    $('#live').textContent = '';
  }
  setTimeout(poll, document.hidden ? POLL_MS * 3 : POLL_MS);
}

$('#model').addEventListener('change', (e) => {
  selected = e.target.value;
  highlight();
  if (selected && $('#preview').checked) previewOnce();
});
$('#graph').addEventListener('click', () => tip()); // tap outside a node closes its tooltip
if (reduceMotion) $('#preview').checked = false;
poll();
previewLoop();
setInterval(() => net && renderRecent(), 15_000); // keep "x min ago" fresh
