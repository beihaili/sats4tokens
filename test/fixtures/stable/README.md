Chain API responses for `test/stable.test.ts`, in the shapes TronGrid, a Base JSON-RPC node and a Solana RPC node
returned on 2026-11-03. Every address, hash and signature was replaced by a synthetic one (sha256 of a label), so no
real party appears; only the public token contracts (USDT on Tron, USDC on Base and Solana) are real. Tests clone and
edit them (head block, confirmation status) per case.
