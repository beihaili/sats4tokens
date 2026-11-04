# sats4tokens skill

Lets a coding agent (Claude Code, OpenClaw, anything that reads `SKILL.md`) top up the Sats4Tokens key it runs
on, paid in sats, within limits you set. The key never changes, so the agent keeps working without a restart.

Status: **preview**. Tested against the unit tests in `test/skill.test.ts`, not yet against a live shop.

## Install

Claude Code: copy this folder to `~/.claude/skills/sats4tokens/` (or `.claude/skills/` in a project).

OpenClaw: copy it to `<workspace>/skills/sats4tokens/`, then give it the key in `~/.openclaw/openclaw.json`:

```json5
skills: { entries: { sats4tokens: { apiKey: "sk-…", env: { S4T_WALLET: "cashu-skill" } } } }
```

OpenClaw passes env only to the host process: a sandboxed agent doesn't get the key.

## Configure (environment)

| variable | default | |
|---|---|---|
| `S4T_KEY` | `ANTHROPIC_AUTH_TOKEN` | the key to top up (only keys sold by the shop work) |
| `S4T_BASE_URL` | `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` | API root the key runs on, for `balance` |
| `S4T_SHOP` | `https://sats4tokens.bhbtc.xyz` | the shop |
| `S4T_WALLET` | `manual` | `manual` (prints the invoice for you to pay), `cashu-skill`, `nutshell` |
| `S4T_CASHU_SKILL_DIR` | `~/cashu-skill` | checkout of [cashubtc/cashu-skill](https://github.com/cashubtc/cashu-skill) |
| `S4T_PAY` | `lightning` | `lightning` works from any mint; `cashu` sends a token, only if your wallet is on the shop's mint |
| `S4T_MAX_PER_TOPUP` | `2` | most one top-up may cost (shop currency) |
| `S4T_MAX_PER_DAY` | `5` | most all top-ups in any 24 hours may cost, counting payments whose outcome is unknown |
| `S4T_MIN_INTERVAL_MIN` | `10` | minutes after a top-up before the agent may pay for another |
| `S4T_STATE` | `~/.sats4tokens/state.json` | local ledger (mode 600): open orders and unsent tokens. Bearer: don't share it |

Over a limit, the script doesn't pay: it makes the order and prints its `/pay/` link for you.
Also set a budget in the wallet itself; the two limits are independent.

Claude Code asks before each Bash command. To let it run only this script without asking, add to
`.claude/settings.json`: `{"permissions": {"allow": ["Bash(node ~/.claude/skills/sats4tokens/s4t.ts:*)"]}}`.

## How it stays exactly-once

The shop credits each paid order once. The script keeps its side: the order id is saved before paying, each
invoice is handed to the wallet at most once (a wallet error or timeout is never retried; the script only
watches the order), a Cashu token is saved before it is sent and only re-sent to the same order. A run that is
interrupted resumes the open order on the next run instead of creating a new one.
