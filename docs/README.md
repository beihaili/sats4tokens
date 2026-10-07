# Sats4Tokens docs

| doc | for |
|---|---|
| [User guide](user-guide.md) | buying a key with Lightning or Cashu and using it (OpenAI SDK, curl, Claude Code) |
| [Self-hosting](self-hosting.md) | running your own shop in front of a new-api relay: setup, mint choice, HTTPS, backups, withdrawals, upgrades |
| [HTTP API](api.md) | every endpoint the gateway serves, with request / response shapes |
| [Agent example](../examples/agent-buy-key.ts) | a script (no dependencies) that buys and pays for a key: `node examples/agent-buy-key.ts 1 [cashu-token]` |
| [How it works](how-it-works.md) | order lifecycle, the ledger, exactly-once settlement and crash recovery |

Also here: [slides.pdf](slides.pdf) (our bitcoin++ Berlin 2026 pitch; prices were in USD then) and `images/` (screenshots built from mock orders).
