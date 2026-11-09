# User guide: buy an AI API key with sats

You pay with Bitcoin (Lightning or Cashu ecash) and get an API key for an OpenAI-compatible endpoint.
No signup, no email, no card. The key holds exactly what you paid and never expires.

Live shop: <https://sats4tokens.bhbtc.xyz/> (mainnet, real sats). Other shops run the same software
on their own domain; replace the URL below with theirs.

## 1. Pick models, an amount and your app

The shop walks you through four steps; each has a default, so you can also go straight to **Pay**:

1. **Models.** Tick the models you plan to use (**All models & prices** lists every one, with its price per 1M
   input / output tokens). This only sizes the key: every key works with every model.
2. **Amount.** **1, 10, 100 or 500** in EUR, USD or CNY (EUR by default). Each amount shows roughly how many chat calls
   it buys on the models you ticked. Larger amounts come with a bonus (10 +5%, 100/500 +10%; 1 has no bonus): the key
   holds that much more, at no extra cost. The same bonus applies to top-ups.
3. **Your app.** Claude Code, Codex CLI, another OpenAI-compatible app, or your own code. You see the setup you will
   paste, with a placeholder key; the key page opens on the same setup with your real key.
4. **Pay.** The button (also in the bar pinned to the bottom of the screen) creates the order. The price in sats is
   fixed the moment you click (spot price, rounded up) and the order is valid for **30 minutes**.

You land on the checkout page, `/pay/CK…`.

> **Save this link.** The order id in it is your receipt *and* the only way to see your key again.
> Anyone who has the link can see and use the key. There is no account to recover it from.

## 2. Pay

The checkout has two tabs, three if the shop takes stablecoins.

### ⚡ Lightning

Scan the QR (or tap **Copy**) with any Lightning wallet and pay the invoice. The page shows **✅ Paid** a
few seconds after the payment lands, then your key. No need to keep the page open: come back to the link later.

### 🥜 Cashu

Send a Cashu token **from the mint shown on the page** (other mints are rejected — pay with ⚡ instead,
any wallet can do that). Either:

- paste the token (`cashuB…`, also with a `cashu:` prefix) — it is paid as soon as it is pasted, or
- tap **📷 Scan QR** and point the camera at the token QR in your wallet. Animated QRs (cashu.me shows
  one for larger tokens) work too; hold the camera still until the progress reaches 100%.

The token must be worth at least the order amount. **Change is not returned**: send the exact amount
(the page shows it), or the extra stays with the shop.

### 💵 USDT / USDC

Shown only when the shop has turned it on. Pick the network you send from (for example **USDT on Tron (TRC-20)**,
**USDC on Base**, **USDC on Solana**); the page then shows our address there (QR + **Copy**) and an exact amount, e.g.
`5.42 USDT`. The order's euro price is converted at the EUR/USD rate of the moment you pick the network.

- **Only that coin on that network.** The same address on another network, or another token, does not reach the
  order. We can only return such a transfer by hand, if at all.
- **Send exactly the amount shown.** Its cents tell your transfer apart from other buyers' (everyone sends to the
  same address). If your exchange takes its withdrawal fee out of the amount, add the fee on top.
- The order is paid once the transfer has enough confirmations (about a minute on Tron, final on Solana); the page
  shows "seen, n/m confirmations" until then. Like ⚡, a transfer that lands after the timer ran out still counts
  (within a day).
- Sent too little? The page says what is missing; send the rest to the same address before the timer runs out.
  After that a key is made for what arrived (e.g. 74% of the order → 74% of the credit). Sent too much? You get the
  full order; contact us for the difference, with the page's link (keep it private).

## 3. Use the key

The paid page shows the key, the endpoint (e.g. `https://sats4tokens.bhbtc.xyz/v1`) and, under **Set it up**,
a ready-to-copy setup for Claude Code, Codex CLI, another app or your own code (it opens on the one you picked in the shop).

**Environment variables** (most OpenAI-compatible tools read them):

```sh
export OPENAI_BASE_URL=https://sats4tokens.bhbtc.xyz/v1
export OPENAI_API_KEY=sk-...
```

**curl**:

```sh
curl https://sats4tokens.bhbtc.xyz/v1/chat/completions \
  -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"hello"}]}'
```

**Python (OpenAI SDK)**:

```python
from openai import OpenAI

client = OpenAI(base_url="https://sats4tokens.bhbtc.xyz/v1", api_key="sk-...")
r = client.chat.completions.create(model="deepseek-flash",
                                   messages=[{"role": "user", "content": "hello"}])
print(r.choices[0].message.content)
```

Use any model name from the list on the page.

**Claude Code**: copy the Claude Code setup from the key page and paste it in a terminal. It looks like this:

```sh
export ANTHROPIC_BASE_URL=https://sats4tokens.bhbtc.xyz
export ANTHROPIC_AUTH_TOKEN=sk-...
export ANTHROPIC_MODEL=claude-opus-4-8
export ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-opus-4-6
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
claude
```

Note the base URL has **no `/v1`** here. Keep `CLAUDE_CODE_MAX_OUTPUT_TOKENS`: the relay reserves
quota for the maximum output up front, and Claude Code's default can ask for more than a small key holds
(you would get `403` / insufficient quota). One Claude Code turn costs a few cents at most.

**Codex CLI**: the Codex setup on the key page adds a `sats4tokens` provider (Responses API, base URL with `/v1`)
to `~/.codex/config.toml` once and starts Codex with it:

```sh
export SATS4TOKENS_API_KEY=sk-...
codex -c model_provider=sats4tokens -m gpt-5.5
```

## 4. Check what's left

The key page shows the balance left and your latest 20 calls (time, model, tokens, cost), refreshed
every 10 seconds. Only you (whoever holds the link) can see it; it shows no prompts or replies.

When less than 10% is left, the key page says so; once it is used up, calls fail with `403` / insufficient quota.

## 5. Top up the key

No need to buy a new key: under the usage on the key page, **Top up this key** has the same amounts (1, 10, 100, 500) and a currency selector. Pick one and you get a normal checkout for it; pay with ⚡ or 🥜 as before. Once it is paid the money is
added to the same key, so nothing in your app or Claude Code changes (a key that was used up works again). The
key page lists your top-ups.

The top-up page never shows the key, only its last 4 characters, the amount added and the new balance. So you
can send a top-up link to someone else (a friend, a team mate, your agent's wallet) and let them pay it.

Agents can do it with one call: `POST /api/buy {"money": 2, "key": "sk-…"}`, then pay the order like any other
(see [api.md](api.md) and `examples/agent-buy-key.ts --topup`).

## 6. Auto top-up from your wallet

If your wallet speaks [Nostr Wallet Connect](https://nwc.dev) (Alby Hub, Coinos, Primal and others), the key can
top itself up:

1. In the wallet, add an app connection that may only **pay invoices**, and give it a budget (e.g. €20 a month).
2. Copy its connection string (`nostr+walletconnect://…`), paste it under **Auto top-up** on the key page, pick the
   amount, the balance to top up at, and a daily cap, then **Turn on auto top-up**.

When the key gets below your threshold, we send that wallet one invoice for one top-up, and the money lands on the
same key as with a manual top-up. We never ask twice for the same invoice, and never more than your daily cap a
day. Your wallet's budget is a second limit we can't go past. If the wallet refuses 3 times in a row (e.g. the budget
is used up), auto top-up pauses and the key page says why; fix it in the wallet and save again.

The connection string is stored on our server until you press **Turn auto top-up off** (that deletes it). Anyone
who could read it could ask your wallet for payments up to its budget, so keep the budget small. Agents can set it
up with `POST /api/autotopup` ([api.md](api.md)).

## FAQ

**The order expired before I paid.** Go back to the shop and create a new one (it gets a fresh price).
If you paid the Lightning invoice just after it expired, the payment is still credited: the shop keeps
watching expired invoices for 24 hours, and the key appears on the same link.

**My Cashu token was rejected.** The message says why: wrong mint (pay with ⚡), too small, already spent,
or not a valid token. Nothing is taken from a rejected token.

**The page says paid but there's no key yet.** The key is created right after payment and retried
automatically if the relay is briefly unreachable; the page shows "Creating your key… (retrying: …)" meanwhile. Keep the link.

**"Sold out right now".** The shop only sells what its pool of API credit can cover, and it is being refilled.
Try a smaller amount or come back later.

**I paid a top-up but the key had been deleted.** The top-up page says so; contact us with the top-up link and we
refund it by hand.

**I lost the link.** The key can't be recovered — it is a bearer receipt by design (no account behind
it). If you still have the key itself, it keeps working.

**Is it private?** The shop learns nothing about you beyond the payment. With Cashu the mint signs blinded
messages and can't link your wallet to the shop. The relay sees your API calls like any API provider does.

## Need help?

- DM **[@sats4tokens](https://x.com/sats4tokens)** on X — the fastest way for payment problems.
- Open an issue on [GitHub](https://github.com/beihaili/sats4tokens/issues) for bugs or anything public.
- Keep your `/pay/…` link and any key in the message private: anyone with them can spend the balance.
