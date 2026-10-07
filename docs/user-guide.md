# User guide: buy an AI API key with sats

You pay with Bitcoin (Lightning or Cashu ecash) and get an API key for an OpenAI-compatible endpoint.
No signup, no email, no card. The key holds exactly what you paid and never expires.

Live shop: <https://sats4tokens.bhbtc.xyz/> (mainnet, real sats). Other shops run the same software
on their own domain; replace the URL below with theirs.

## 1. Pick an amount

Open the shop and choose **1, 2, 5 or 10** in the shop's currency (e.g. €1–€10). The price in sats is fixed the moment you click
(spot price, rounded up) and the order is valid for **30 minutes**.

The bottom of the page lists every model the key can call, with its price per 1M input /
output tokens. Tick a few models to see roughly how many tokens or chat calls each amount buys.

You land on the checkout page, `/pay/CK…`.

> **Save this link.** The order id in it is your receipt *and* the only way to see your key again.
> Anyone who has the link can see and use the key. There is no account to recover it from.

## 2. Pay

The checkout has two tabs.

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

## 3. Use the key

The paid page shows the key, the endpoint (e.g. `https://sats4tokens.bhbtc.xyz/v1`) and
ready-to-copy snippets.

**Environment variables** (most OpenAI-compatible tools read them):

```sh
export OPENAI_BASE_URL=https://sats4tokens.bhbtc.xyz/v1
export OPENAI_API_KEY=sk-...
```

**curl**:

```sh
curl https://sats4tokens.bhbtc.xyz/v1/chat/completions \
  -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hello"}]}'
```

**Python (OpenAI SDK)**:

```python
from openai import OpenAI

client = OpenAI(base_url="https://sats4tokens.bhbtc.xyz/v1", api_key="sk-...")
r = client.chat.completions.create(model="deepseek-v4-flash",
                                   messages=[{"role": "user", "content": "hello"}])
print(r.choices[0].message.content)
```

Use any model name from the list on the page.

**Claude Code**: copy the one-line command from the key page. It looks like this:

```sh
ANTHROPIC_BASE_URL=https://sats4tokens.bhbtc.xyz ANTHROPIC_AUTH_TOKEN=sk-... \
ANTHROPIC_MODEL=claude-opus-4-8 ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-opus-4-6 \
CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude
```

Note the base URL has **no `/v1`** here. Keep `CLAUDE_CODE_MAX_OUTPUT_TOKENS`: the relay reserves
quota for the maximum output up front, and Claude Code's default can ask for more than a small key holds
(you would get `403` / insufficient quota). One Claude Code turn costs a few cents at most.

## 4. Check what's left

The key page shows the balance left and your latest 20 calls (time, model, tokens, cost), refreshed
every 10 seconds. Only you (whoever holds the link) can see it; it shows no prompts or replies.

When less than 10% is left, the key page says so with a link to buy another key; once it is used up, calls
fail with `403` / insufficient quota. Topping up an existing key isn't possible yet.

## FAQ

**The order expired before I paid.** Go back to the shop and create a new one (it gets a fresh price).
If you paid the Lightning invoice just after it expired, the payment is still credited: the shop keeps
watching expired invoices for 24 hours, and the key appears on the same link.

**My Cashu token was rejected.** The message says why: wrong mint (pay with ⚡), too small, already spent,
or not a valid token. Nothing is taken from a rejected token.

**The page says paid but there's no key yet.** The key is created right after payment and retried
automatically if the relay is briefly unreachable; the page shows "Creating your key… (retrying: …)" meanwhile. Keep the link.

**I lost the link.** The key can't be recovered — it is a bearer receipt by design (no account behind
it). If you still have the key itself, it keeps working.

**Is it private?** The shop learns nothing about you beyond the payment. With Cashu the mint signs blinded
messages and can't link your wallet to the shop. The relay sees your API calls like any API provider does.
