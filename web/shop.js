import { money, bonusText } from './models.js?v=11';

/** Create a key (or key top-up) order and go to its checkout page. Throws the gateway's error message. */
export async function buy({ money, currency, key, ref }) {
  const r = await fetch('/api/buy', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ money, currency, key, ref }) });
  const order = await r.json();
  if (!r.ok) throw new Error(order.error);
  location.href = '/pay/' + order.id;
}

// A currency switch invalidates every button from the previous quote, including in-flight renders.
export function mountShop({ select, buttons, message, key, ref, onShop }) {
  let generation = 0;
  const say = text => { message.textContent = text; message.hidden = !text; };
  async function refresh() {
    const current = ++generation;
    const currency = select.value;
    buttons.replaceChildren();
    say('Loading amounts…');
    try {
      const response = await fetch('/api/shop?currency=' + currency);
      const shop = await response.json();
      if (current !== generation) return;
      if (!response.ok) throw new Error(shop.error);
      onShop?.(shop);
      if (!shop.enabled) return say('No amounts available right now. Try another currency or check back later.');
      for (const amount of (shop.tiers ?? shop.amounts)) {
        const b = document.createElement('button');
        b.className = 'primary';
        const available = shop.amounts.includes(amount);
        b.disabled = !available;
        b.dataset.available = String(available);
        const label = money(Number(amount), currency);
        const credit = Number(amount) * (1 + (shop.bonus[amount] ?? 0) / 100);
        b.append(Object.assign(document.createElement('b'), { textContent: (key ? '+ ' : '') + label }));
        if (!key && shop.sats?.[amount]) b.append(Object.assign(document.createElement('small'), { textContent: '≈ ' + shop.sats[amount].toLocaleString('en') + ' sat' }));
        const bonus = bonusText(shop, amount);
        if (key || bonus) b.append(Object.assign(document.createElement(key ? 'small' : 'em'), {
          textContent: [bonus, key && money(credit, currency) + ' credit'].filter(Boolean).join(' · '),
        }));
        if (!available) b.append(Object.assign(document.createElement('small'), {
          // guide to what can be bought right now instead of a dead end
          textContent: shop.amounts.length ? `Sold out — ${money(Number(shop.amounts[shop.amounts.length - 1]), currency)} is available` : 'Sold out right now',
        }));
        b.onclick = async () => {
          select.disabled = true;
          for (const button of buttons.children) button.disabled = true;
          try {
            await buy({ money: amount, currency, key, ref });
          } catch (e) {
            say(e.message);
            select.disabled = false;
            for (const button of buttons.children) button.disabled = button.dataset.available !== 'true';
          }
        };
        buttons.append(b);
      }
      say(currency === shop.accountFiat ? '' : 'Account credit in ' + shop.accountFiat.toUpperCase() + ' · 1 ' +
        currency.toUpperCase() + ' ≈ ' + Number(shop.accountRate.toFixed(6)) + ' ' + shop.accountFiat.toUpperCase() + '. Final quote on checkout.');
    } catch (e) {
      if (current === generation) {
        say(e.message + ' ');
        const retry = document.createElement('button');
        retry.textContent = 'Retry';
        retry.onclick = refresh;
        message.append(retry);
      }
    }
  }
  select.onchange = refresh;
  void refresh();
}
