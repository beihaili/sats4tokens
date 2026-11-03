// Stablecoin rails (USDT / USDC on Tron, Base, Solana, …): which ones we accept, and read-only scanners that list the
// transfers our receiving addresses got. Watch only: the server knows public addresses, never a key, and never sends
// anything. Matching transfers to orders is in stable.ts; this file only talks to the chains.
//
//   STABLE_ADDR_EVM   0x… receiving address on every EVM chain (Base by default; more with STABLE_EVM_CHAINS)
//   STABLE_ADDR_TRON  T… receiving address on Tron (USDT TRC-20)
//   STABLE_ADDR_SOL   Solana wallet address (USDC + USDT arrive in its associated token accounts, derived here)
// A network without an address is off (not on the checkout page). RPC endpoints, keys and confirmations: railsFromEnv.
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export type Token = 'USDT' | 'USDC';
export type NetKind = 'tron' | 'evm' | 'solana';

export interface Rail {
  id: string; // 'tron-usdt', 'base-usdc', 'solana-usdc' — also the order's paid.via
  net: string; // 'tron', 'base', 'solana', or an extra EVM chain's id
  netName: string; // shown to buyers: 'Tron (TRC-20)', 'Base', 'Solana'
  kind: NetKind;
  token: Token;
  contract: string; // token contract (EVM: lowercase hex; Tron: base58) or SPL mint
  decimals: number;
  address: string; // our receiving address (public). EVM: lowercase
  account?: string; // Solana: our associated token account for `contract` (what transfers actually credit)
  rpc: string;
  apiKey?: string; // Tron: TRON-PRO-API-KEY header (EVM/Solana providers put their key in the URL)
  confirmations: number; // blocks incl. the transfer's own; Solana: 1 = finalized
  blockTimeS: number; // EVM: rough block time, to find the first block to scan
  maxRange: number; // EVM: blocks per eth_getLogs call (providers cap the range)
  explorer: string; // tx URL prefix
}

/** An incoming transfer of `rail`'s token to our address. `key` is unique per transfer (one tx can hold several). */
export interface Transfer {
  rail: string;
  key: string;
  tx: string;
  units: bigint; // in the token's smallest unit
  at: number; // block time, ms
  confirmations: number;
  need: number;
  from?: string;
}

// ------------------------------------------------------------------ config

interface EvmChain {
  id: string;
  name: string;
  rpc: string;
  confirmations: number;
  blockTime: number;
  maxRange?: number;
  explorer: string;
  tokens: Partial<Record<Token, string | { contract: string; decimals: number }>>;
}

// Defaults. Public RPCs rate-limit hard (some refuse eth_getLogs without a key): set STABLE_<NET>_RPC for production.
const EVM_CHAINS: EvmChain[] = [
  {
    id: 'base', name: 'Base', rpc: 'https://mainnet.base.org', confirmations: 30, blockTime: 2, explorer: 'https://basescan.org/tx/',
    tokens: { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  },
];
const TRON = { rpc: 'https://api.trongrid.io', confirmations: 19, explorer: 'https://tronscan.org/#/transaction/', usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' };
const SOLANA = {
  rpc: 'https://api.mainnet-beta.solana.com', explorer: 'https://solscan.io/tx/',
  mints: { USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT: 'Es9vMFrzaCERmJfrF4H2gdWr4oE8EW8oxT6R8UVTeD1y' } as Record<Token, string>,
};

const envKey = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const num = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);

/**
 * The rails this gateway accepts, from env. Throws on a malformed address: a typo there sends money nowhere.
 *   STABLE_EVM_CHAINS  JSON list of extra EVM chains (or overrides of 'base'), e.g.
 *     [{"id":"arbitrum","name":"Arbitrum","rpc":"https://…","confirmations":20,"blockTime":0.25,
 *       "explorer":"https://arbiscan.io/tx/","tokens":{"USDC":"0x…"}}]  (a token may be {"contract","decimals"})
 *   STABLE_<NET>_RPC, STABLE_<NET>_CONFIRMATIONS   per network (NET = TRON, SOL, BASE, or an extra chain's id)
 *   STABLE_TRON_API_KEY                            TronGrid key (header); other providers take theirs in the URL
 *   STABLE_RAILS       optional allow-list, e.g. "tron-usdt,base-usdc,solana-usdc"
 */
export function railsFromEnv(env: Record<string, string | undefined>): Rail[] {
  const rails: Rail[] = [];
  const tron = env.STABLE_ADDR_TRON?.trim();
  if (tron) {
    if (!isTronAddress(tron)) throw new Error('STABLE_ADDR_TRON is not a valid Tron address (T…, base58check)');
    rails.push({
      id: 'tron-usdt', net: 'tron', netName: 'Tron (TRC-20)', kind: 'tron', token: 'USDT', contract: TRON.usdt, decimals: 6,
      address: tron, rpc: env.STABLE_TRON_RPC || TRON.rpc, apiKey: env.STABLE_TRON_API_KEY || undefined,
      confirmations: num(env.STABLE_TRON_CONFIRMATIONS, TRON.confirmations), blockTimeS: 3, maxRange: 0, explorer: TRON.explorer,
    });
  }
  const evm = env.STABLE_ADDR_EVM?.trim();
  if (evm) {
    if (!isEvmAddress(evm)) throw new Error('STABLE_ADDR_EVM is not a valid 0x address (or its EIP-55 checksum is wrong)');
    const chains = [...EVM_CHAINS];
    for (const c of env.STABLE_EVM_CHAINS ? (JSON.parse(env.STABLE_EVM_CHAINS) as EvmChain[]) : []) {
      if (!/^[a-z][a-z0-9]{1,15}$/.test(c.id ?? '')) throw new Error(`STABLE_EVM_CHAINS: bad id ${JSON.stringify(c.id)}`);
      const i = chains.findIndex((x) => x.id === c.id);
      if (i >= 0) chains[i] = { ...chains[i], ...c };
      else chains.push(c);
    }
    for (const c of chains) {
      const k = envKey(c.id);
      for (const [token, t] of Object.entries(c.tokens ?? {}) as Array<[Token, EvmChain['tokens'][Token]]>) {
        if (token !== 'USDT' && token !== 'USDC') throw new Error(`STABLE_EVM_CHAINS ${c.id}: only USDT/USDC (got ${token})`);
        const contract = typeof t === 'string' ? t : t!.contract;
        if (!isEvmAddress(contract)) throw new Error(`STABLE_EVM_CHAINS ${c.id}: bad ${token} contract`);
        rails.push({
          id: `${c.id}-${token.toLowerCase()}`, net: c.id, netName: c.name, kind: 'evm', token, contract: contract.toLowerCase(),
          decimals: typeof t === 'string' ? 6 : t!.decimals, address: evm.toLowerCase(), rpc: env[`STABLE_${k}_RPC`] || c.rpc,
          confirmations: num(env[`STABLE_${k}_CONFIRMATIONS`], c.confirmations), blockTimeS: c.blockTime || 2,
          maxRange: c.maxRange ?? 2000, explorer: c.explorer,
        });
      }
    }
  }
  const sol = env.STABLE_ADDR_SOL?.trim();
  if (sol) {
    const owner = solanaWallet(sol);
    for (const token of ['USDC', 'USDT'] as const) {
      rails.push({
        id: `solana-${token.toLowerCase()}`, net: 'solana', netName: 'Solana', kind: 'solana', token, contract: SOLANA.mints[token],
        decimals: 6, address: sol, account: b58encode(associatedTokenAccount(owner, b58decode(SOLANA.mints[token]))),
        rpc: env.STABLE_SOL_RPC || SOLANA.rpc, confirmations: 1, blockTimeS: 0.4, maxRange: 0, explorer: SOLANA.explorer,
      });
    }
  }
  const only = env.STABLE_RAILS?.split(',').map((s) => s.trim()).filter(Boolean);
  return only?.length ? rails.filter((r) => only.includes(r.id)) : rails;
}

// ------------------------------------------------------------------ addresses

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('not base58');
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

/** Tron: base58check of 0x41 + 20 bytes, checksum = first 4 bytes of sha256(sha256(payload)). */
export function isTronAddress(s: string): boolean {
  let b: Uint8Array;
  try {
    b = b58decode(s);
  } catch {
    return false;
  }
  if (b.length !== 25 || b[0] !== 0x41) return false;
  const sum = sha256(sha256(b.subarray(0, 21)));
  return sum.subarray(0, 4).every((x, i) => x === b[21 + i]);
}

/** 0x + 40 hex; mixed case must be a correct EIP-55 checksum (all-lower / all-upper carry none). */
export function isEvmAddress(s: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return false;
  const hex = s.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  const h = Buffer.from(keccak_256(new TextEncoder().encode(hex.toLowerCase()))).toString('hex');
  return [...hex].every((c, i) => (parseInt(h[i], 16) >= 8 ? c === c.toUpperCase() : c === c.toLowerCase()));
}

const onCurve = (b: Uint8Array): boolean => {
  try {
    ed25519.Point.fromBytes(b, true);
    return true;
  } catch {
    return false;
  }
};

/** A Solana wallet address: 32 bytes on the ed25519 curve. A token account or other PDA (off curve) is refused. */
function solanaWallet(s: string): Uint8Array {
  let b: Uint8Array | undefined;
  try {
    b = b58decode(s);
  } catch {
    b = undefined;
  }
  if (b?.length !== 32) throw new Error('STABLE_ADDR_SOL is not a Solana address');
  if (!onCurve(b)) throw new Error('STABLE_ADDR_SOL looks like a token account or program address: give the wallet address');
  return b;
}

const TOKEN_PROGRAM = b58decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = b58decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** findProgramAddress: the first bump (255 down) whose hash is off the curve. */
export function programAddress(seeds: Uint8Array[], program: Uint8Array): Uint8Array {
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(...seeds, Uint8Array.of(bump), program, new TextEncoder().encode('ProgramDerivedAddress'));
    if (!onCurve(h)) return h;
  }
  throw new Error('no program address');
}

/** The associated token account of `owner` for `mint` (classic token program: USDC and USDT on Solana). */
export const associatedTokenAccount = (owner: Uint8Array, mint: Uint8Array): Uint8Array =>
  programAddress([owner, TOKEN_PROGRAM, mint], ATA_PROGRAM);

// ------------------------------------------------------------------ scanners

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
/** Per-rail state the caller keeps durable (EVM: next block to scan). */
export interface ScanState {
  cursor?: number;
}

async function getJson(f: Fetch, url: string, init?: RequestInit): Promise<any> {
  const r = await f(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.json();
}

let rpcId = 0;
async function rpc(f: Fetch, url: string, method: string, params: unknown[]): Promise<any> {
  const j = await getJson(f, url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (j.error) throw new Error(`${method}: RPC ${j.error.code}: ${j.error.message}`);
  return j.result;
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAX_PAGES = 5;

/**
 * Lists incoming transfers on one rail since a time. Read-only. Remembers what can't change (a tx's block, a Solana
 * transfer's amount, a block's time) so each pass asks only about what's new. Throws on any RPC error: the caller
 * backs off and retries the whole pass.
 */
export class Scanner {
  rail: Rail;
  private f: Fetch;
  private txBlock = new Map<string, { block: number; ok: boolean }>(); // tron
  private blockTime = new Map<number, number>(); // evm
  private solAmount = new Map<string, bigint>(); // solana

  constructor(rail: Rail, f: Fetch = fetch) {
    this.rail = rail;
    this.f = f;
  }

  /** Transfers at or after `since` (ms). `done` = transfer keys the caller already counted (skipped, no lookups). */
  scan(since: number, state: ScanState, done: Set<string>, now = Date.now()): Promise<Transfer[]> {
    if (this.rail.kind === 'tron') return this.tron(since, done);
    if (this.rail.kind === 'evm') return this.evm(since, state, done, now);
    return this.solana(since, done);
  }

  // TronGrid: GET /v1/accounts/:addr/transactions/trc20 (only_to, our token contract) lists the transfers; a tx's block
  // comes from /wallet/gettransactioninfobyid (which also says whether it succeeded), the head from /wallet/getblock.
  private async tron(since: number, done: Set<string>): Promise<Transfer[]> {
    const r = this.rail;
    const base = r.rpc.replace(/\/+$/, '');
    const headers: Record<string, string> = r.apiKey ? { 'TRON-PRO-API-KEY': r.apiKey } : {};
    const q = `only_to=true&contract_address=${r.contract}&min_timestamp=${since}&limit=200&order_by=block_timestamp,asc`;
    const items: any[] = [];
    let fingerprint = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const j = await getJson(this.f, `${base}/v1/accounts/${r.address}/transactions/trc20?${q}${fingerprint ? `&fingerprint=${fingerprint}` : ''}`, { headers });
      if (!j.success) throw new Error(`trongrid: ${j.error ?? 'not success'}`);
      items.push(...(j.data ?? []));
      fingerprint = j.meta?.fingerprint ?? '';
      if (!fingerprint || (j.data ?? []).length < 200) break;
    }
    const fresh = items.filter(
      (it) => it.type === 'Transfer' && it.to === r.address && it.token_info?.address === r.contract && /^\d+$/.test(it.value ?? '')
        && BigInt(it.value) > 0n && !done.has(it.transaction_id),
    );
    if (!fresh.length) return [];
    const post = (path: string, body: unknown) => getJson(this.f, base + path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const head = Number((await post('/wallet/getblock', { detail: false })).block_header?.raw_data?.number);
    if (!(head > 0)) throw new Error('trongrid: no head block');
    const out: Transfer[] = [];
    for (const it of fresh) {
      let b = this.txBlock.get(it.transaction_id);
      if (!b) {
        const info = await post('/wallet/gettransactioninfobyid', { value: it.transaction_id });
        if (info.blockNumber) this.txBlock.set(it.transaction_id, (b = { block: info.blockNumber, ok: info.receipt?.result === 'SUCCESS' }));
      }
      if (b && !b.ok) continue; // reverted: no money moved
      out.push({
        rail: r.id, key: it.transaction_id, tx: it.transaction_id, units: BigInt(it.value), at: Number(it.block_timestamp),
        confirmations: b ? Math.max(0, head - b.block + 1) : 0, need: r.confirmations, from: it.from,
      });
    }
    return out;
  }

  // EVM: eth_getLogs for Transfer(…, to = us) on the token contract, from a durable cursor. The cursor stops below the
  // first unconfirmed block, so those are scanned again (and a reorged-out log simply isn't there any more).
  private async evm(since: number, state: ScanState, done: Set<string>, now: number): Promise<Transfer[]> {
    const r = this.rail;
    const head = Number(await rpc(this.f, r.rpc, 'eth_blockNumber', []));
    if (!(head > 0)) throw new Error('eth_blockNumber: no head');
    const safeTop = head - r.confirmations + 1; // highest block with enough confirmations
    // where `since` roughly is, with slack for a wrong block time (older transfers are dropped by `at` below)
    const back = Math.ceil((((now - since) / 1000) * 1.2) / r.blockTimeS) + 50;
    let from = Math.max(state.cursor ?? 0, head - back, 0);
    const toTopic = '0x' + r.address.slice(2).padStart(64, '0');
    const logs: any[] = [];
    let scanned = from - 1;
    for (let i = 0; i < MAX_PAGES && from <= head; i++) {
      const to = Math.min(head, from + r.maxRange - 1);
      const got = await rpc(this.f, r.rpc, 'eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), address: r.contract, topics: [TRANSFER_TOPIC, null, toTopic] }]);
      logs.push(...got);
      scanned = to;
      from = to + 1;
    }
    state.cursor = Math.min(scanned, safeTop) + 1;
    const out: Transfer[] = [];
    for (const l of logs) {
      const key = `${l.transactionHash}:${Number(l.logIndex)}`;
      if (l.removed || done.has(key) || String(l.address).toLowerCase() !== r.contract || String(l.topics?.[2]).toLowerCase() !== toTopic) continue;
      const units = BigInt(l.data === '0x' ? 0 : l.data);
      if (units <= 0n) continue;
      const bn = Number(l.blockNumber);
      let at = l.blockTimestamp ? Number(l.blockTimestamp) * 1000 : this.blockTime.get(bn);
      if (at === undefined) {
        at = Number((await rpc(this.f, r.rpc, 'eth_getBlockByNumber', [hex(bn), false])).timestamp) * 1000;
        this.blockTime.set(bn, at);
      }
      out.push({ rail: r.id, key, tx: l.transactionHash, units, at, confirmations: head - bn + 1, need: r.confirmations, from: '0x' + String(l.topics[1]).slice(26) });
    }
    return out;
  }

  // Solana: getSignaturesForAddress on our token account (newest first, paged back to `since`), each new transaction
  // read once (jsonParsed) for what our account gained. Final = the signature's confirmationStatus is 'finalized'.
  private async solana(since: number, done: Set<string>): Promise<Transfer[]> {
    const r = this.rail;
    const sigs: any[] = [];
    let before: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const got: any[] = await rpc(this.f, r.rpc, 'getSignaturesForAddress', [r.account, { limit: 100, commitment: 'confirmed', ...(before ? { before } : {}) }]);
      sigs.push(...got);
      if (got.length < 100 || (got.at(-1).blockTime ?? 0) * 1000 < since) break;
      before = got.at(-1).signature;
    }
    const out: Transfer[] = [];
    for (const s of sigs) {
      if (s.err || !s.blockTime || s.blockTime * 1000 < since || done.has(s.signature)) continue;
      let units = this.solAmount.get(s.signature);
      if (units === undefined) {
        const tx = await rpc(this.f, r.rpc, 'getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
        if (!tx) continue; // not served yet: next pass
        this.solAmount.set(s.signature, (units = this.received(tx)));
      }
      if (units <= 0n) continue;
      out.push({ rail: r.id, key: s.signature, tx: s.signature, units, at: s.blockTime * 1000, confirmations: s.confirmationStatus === 'finalized' ? 1 : 0, need: 1 });
    }
    return out;
  }

  /** What our token account gained in a jsonParsed transaction (post − pre balance of our mint); 0 if it failed. */
  private received(tx: any): bigint {
    if (tx.meta?.err) return 0n;
    const keys: string[] = (tx.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? k : k.pubkey));
    const ours = (b: any) => b.mint === this.rail.contract && (keys[b.accountIndex] === this.rail.account || (keys[b.accountIndex] === undefined && b.owner === this.rail.address));
    const amount = (list: any[] | undefined) => BigInt(list?.find(ours)?.uiTokenAmount?.amount ?? 0);
    return amount(tx.meta?.postTokenBalances) - amount(tx.meta?.preTokenBalances);
  }
}

const hex = (n: number) => '0x' + n.toString(16);
