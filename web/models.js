// Models & prices table (key shop): GET /api/models, grouped by vendor. Used by the buy page and the key page.
const fmt = (x) => (x === undefined ? '—' : '$' + Number(x.toFixed(x < 1 ? 3 : 2)));

export async function renderModels(el) {
  const r = await fetch('/api/models');
  if (!r.ok) {
    el.closest('section').hidden = true;
    return;
  }
  const list = await r.json();
  const vendors = [...new Set(list.map((m) => m.vendor))];
  const table = document.createElement('table');
  table.className = 'calls prices';
  table.innerHTML = '<thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached</th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const v of vendors) {
    const head = document.createElement('tr');
    head.className = 'vendor';
    const cell = Object.assign(document.createElement('td'), { colSpan: 4, textContent: v });
    // every model speaks the OpenAI API; mark vendors whose models also speak Anthropic's (= Claude Code works)
    if (list.some((m) => m.vendor === v && m.endpoints.includes('anthropic'))) {
      cell.append(Object.assign(document.createElement('span'), { className: 'badge anthropic', textContent: 'Claude Code' }));
    }
    head.append(cell);
    tbody.append(head);
    for (const m of list.filter((x) => x.vendor === v)) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.append(Object.assign(document.createElement('code'), { textContent: m.model }));
      if (m.fastTier) name.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: 'fast ×2' }));
      tr.append(name);
      if (m.perCall !== undefined) {
        tr.append(Object.assign(document.createElement('td'), { colSpan: 3, textContent: `${fmt(m.perCall)} per image` }));
      } else {
        for (const x of [m.input, m.output, m.cacheRead]) tr.append(Object.assign(document.createElement('td'), { textContent: fmt(x) }));
      }
      tbody.append(tr);
    }
  }
  table.append(tbody);
  const wrap = Object.assign(document.createElement('div'), { className: 'scroll' });
  wrap.append(table);
  el.replaceChildren(wrap);
}
