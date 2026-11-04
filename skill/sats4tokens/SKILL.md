---
name: sats4tokens
description: Check and top up the Sats4Tokens AI API key you are running on, paid in bitcoin (Lightning or Cashu ecash). Use when an API call fails with 401 Invalid token or 403 token quota is not enough, or before a long task when the balance may be low.
metadata: {"openclaw":{"emoji":"🔑","requires":{"bins":["node"]},"primaryEnv":"S4T_KEY"}}
---

# sats4tokens: top up your own API key

Your API key was bought at a Sats4Tokens shop. Its credit runs out; this skill adds more, paid in sats from a
wallet the human set up. Spending limits are enforced by the script, not by you.

Run the script with Node (≥ 22.18) from this skill's folder: `node s4t.ts <command>`. It prints JSON on stdout.
Exit code 2 means **stop and tell the human** the message it printed (it says whether anything was paid).

## When to use it

1. An API call failed. Ask what it means:
   `node s4t.ts classify <http status> '<response body>'`
   - `topup`: the key is probably used up (new-api answers a used-up key with 401 "Invalid token"). Top up.
   - `check-balance`: the key has some credit, not enough for this call. Run `balance`: if it is low, top up;
     if not, the request asked for too many output tokens, so lower max_tokens instead of paying.
   - `pool-empty`: the shop itself has no credit. Do **not** top up. Tell the human the shop is sold out.
   - `not-ours`: some other error. This skill can't help.
2. Before a long task: `node s4t.ts balance`. If `remaining` is below what the task will likely cost, top up first.

## Topping up

- `node s4t.ts prices` lists the amounts you can buy.
- `node s4t.ts topup <amount>` pays and waits until the credit is on the key, then prints `{added, remaining}`.
  Pick the smallest amount that covers the task. The key stays the same, so nothing needs a restart.
- After a top-up, retry the failed call **once**. If it fails again, stop and tell the human.
- Top up at most once per conversation. If the script refuses (limit, sold out, unknown key, wallet error),
  do not try other amounts or workarounds: pass its message to the human.
- If a run was interrupted, just run `topup` again: it finishes the open top-up and never pays twice.

## Never

- Never print, log or paste the key, the state file, Cashu tokens or `/pay/` links into public places.
  A `/pay/` link may be shown to the human you work for.
- Never edit the state file or the limits to get past a refusal.
