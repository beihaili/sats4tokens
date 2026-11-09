// Trial keys for bitcoin holders: sign a message with an address that held ≥ PROOF_MIN_SATS at a snapshot block and
// still holds those coins, get a small key once per address. No network in the pure parts (verify, challenge, count);
// the balance comes from an Esplora API (mempool.space by default) through an injectable fetch.
//
// Signatures accepted:
//   * BIP-137 / "Bitcoin Signed Message" (65 bytes, header 27–42): Bitcoin Core (legacy), Electrum, Sparrow, Trezor,
//     Coldcard. The recovered key may match the address as P2PKH, P2SH-P2WPKH or P2WPKH whatever the header says
//     (Electrum signs segwit addresses with the "compressed P2PKH" header), as most verifiers do.
//   * BIP-322 "simple" (base64 witness): P2WPKH and P2TR key path (Sparrow, UniSat, Xverse, Leather, Bitcoin Core).
// Not supported: multisig / script addresses (P2WSH, bare P2SH scripts), P2TR script path.
//
// Anti-farming: only UTXOs confirmed at or before the snapshot height count, and they must still be unspent. Moving
// coins to a fresh address makes new UTXOs after the snapshot, so the same 0.01 BTC can't claim twice. Each address
// claims once (stored as an HMAC with a secret salt, never the address itself), and the operator caps the total.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { LedgerData, Order } from './ledger.ts';
import { cleanRef } from './funnel.ts';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { bech32, bech32m, createBase58check } from '@scure/base';

// ------------------------------------------------------------------ addresses (mainnet)

export type AddrType = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2tr';
export interface Addr { type: AddrType; hash: Uint8Array; script: Uint8Array }

const b58 = createBase58check(sha256);
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
const sha256d = (b: Uint8Array) => sha256(sha256(b));

function scriptOf(type: AddrType, h: Uint8Array): Uint8Array {
  switch (type) {
    case 'p2pkh': return concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), h, new Uint8Array([0x88, 0xac]));
    case 'p2sh': return concatBytes(new Uint8Array([0xa9, 0x14]), h, new Uint8Array([0x87]));
    case 'p2wpkh': return concatBytes(new Uint8Array([0x00, 0x14]), h);
    case 'p2tr': return concatBytes(new Uint8Array([0x51, 0x20]), h);
  }
}

/** A mainnet address we can verify signatures for, or an error message. */
export function parseAddress(s: string): Addr | string {
  const a = s.trim();
  if (/^(bc1|BC1)/.test(a)) {
    const lower = a.toLowerCase();
    if (a !== lower && a !== a.toUpperCase()) return 'mixed-case address';
    let version: number, program: Uint8Array;
    try {
      const d = lower.startsWith('bc1p') ? bech32m.decode(lower as `${string}1${string}`) : bech32.decode(lower as `${string}1${string}`);
      if (d.prefix !== 'bc') return 'not a mainnet address';
      version = d.words[0];
      program = bech32.fromWords(d.words.slice(1));
    } catch {
      return 'invalid address';
    }
    if (version === 0 && program.length === 20) return { type: 'p2wpkh', hash: program, script: scriptOf('p2wpkh', program) };
    if (version === 0 && program.length === 32) return 'multisig / script addresses (P2WSH) are not supported';
    if (version === 1 && program.length === 32) return { type: 'p2tr', hash: program, script: scriptOf('p2tr', program) };
    return 'unsupported address type';
  }
  let raw: Uint8Array;
  try {
    raw = b58.decode(a);
  } catch {
    return 'invalid address';
  }
  if (raw.length !== 21) return 'invalid address';
  const h = raw.slice(1);
  if (raw[0] === 0x00) return { type: 'p2pkh', hash: h, script: scriptOf('p2pkh', h) };
  if (raw[0] === 0x05) return { type: 'p2sh', hash: h, script: scriptOf('p2sh', h) };
  return 'not a mainnet address';
}

/** bech32 addresses in lowercase (they may be typed in either case); base58 ones as they are. */
export const normalizeAddress = (s: string) => (/^bc1/i.test(s.trim()) ? s.trim().toLowerCase() : s.trim());

// ------------------------------------------------------------------ serialization helpers

function varint(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, n >> 8]);
  return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]);
}
const varstr = (b: Uint8Array) => concatBytes(varint(b.length), b);
const u32 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]);
const ZERO8 = new Uint8Array(8);

function fromBase64(s: string): Uint8Array | undefined {
  const t = s.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return undefined;
  return new Uint8Array(Buffer.from(t, 'base64'));
}

// ------------------------------------------------------------------ BIP-137

/** sha256d of "\x18Bitcoin Signed Message:\n" + varint(len) + message. */
export function bip137Hash(message: string): Uint8Array {
  return sha256d(concatBytes(varstr(utf8ToBytes('Bitcoin Signed Message:\n')), varstr(utf8ToBytes(message))));
}

function verifyBip137(addr: Addr, message: string, sig: Uint8Array): boolean {
  if (sig.length !== 65 || sig[0] < 27 || sig[0] > 42) return false;
  const recid = (sig[0] - 27) & 3;
  const compressed = sig[0] >= 31;
  let pub: Uint8Array;
  try {
    // noble's 'recovered' format = recovery byte, then r, s
    pub = secp256k1.recoverPublicKey(concatBytes(new Uint8Array([recid]), sig.slice(1)), bip137Hash(message), { prehash: false });
  } catch {
    return false;
  }
  const point = secp256k1.Point.fromBytes(pub);
  if (!compressed) return addr.type === 'p2pkh' && eq(hash160(point.toBytes(false)), addr.hash);
  const h = hash160(point.toBytes(true));
  if (addr.type === 'p2pkh' || addr.type === 'p2wpkh') return eq(h, addr.hash);
  if (addr.type === 'p2sh') return eq(hash160(scriptOf('p2wpkh', h)), addr.hash); // P2SH-P2WPKH
  return false;
}

// ------------------------------------------------------------------ BIP-322 simple

const tagged = (tag: string, msg: Uint8Array) => {
  const t = sha256(utf8ToBytes(tag));
  return sha256(concatBytes(t, t, msg));
};
export const bip322Hash = (message: string) => tagged('BIP0322-signed-message', utf8ToBytes(message));

/** The virtual to_spend transaction's txid (internal byte order) for this message and address script. */
export function toSpendTxid(message: string, script: Uint8Array): Uint8Array {
  const tx = concatBytes(
    u32(0), varint(1),
    new Uint8Array(32), u32(0xffffffff), varstr(concatBytes(new Uint8Array([0x00, 0x20]), bip322Hash(message))), u32(0),
    varint(1), ZERO8, varstr(script),
    u32(0),
  );
  return sha256d(tx);
}

const OP_RETURN_OUT = concatBytes(ZERO8, varstr(new Uint8Array([0x6a])));

/** BIP-143 sighash (SIGHASH_ALL) of to_sign's only input, spending a P2WPKH output of 0 sat. */
export function segwitV0Sighash(prevTxid: Uint8Array, pkh: Uint8Array): Uint8Array {
  const outpoint = concatBytes(prevTxid, u32(0));
  return sha256d(concatBytes(
    u32(0), sha256d(outpoint), sha256d(u32(0)), outpoint,
    varstr(scriptOf('p2pkh', pkh)), ZERO8, u32(0),
    sha256d(OP_RETURN_OUT), u32(0), u32(1),
  ));
}

/** BIP-341 key-path sighash of to_sign's only input (hashType 0 = DEFAULT, 1 = ALL). */
export function taprootSighash(prevTxid: Uint8Array, script: Uint8Array, hashType: 0 | 1): Uint8Array {
  return tagged('TapSighash', concatBytes(
    new Uint8Array([0x00, hashType]), u32(0), u32(0),
    sha256(concatBytes(prevTxid, u32(0))), sha256(ZERO8), sha256(varstr(script)), sha256(u32(0)),
    sha256(OP_RETURN_OUT),
    new Uint8Array([0x00]), u32(0),
  ));
}

/** Witness stack from a BIP-322 simple signature, or undefined. */
export function parseWitness(b: Uint8Array): Uint8Array[] | undefined {
  let i = 0;
  const readLen = (): number | undefined => {
    if (i >= b.length) return undefined;
    const f = b[i++];
    if (f < 0xfd) return f;
    if (f === 0xfd && i + 2 <= b.length) { const n = b[i] | (b[i + 1] << 8); i += 2; return n; }
    return undefined;
  };
  const n = readLen();
  if (n === undefined || n > 10) return undefined;
  const items: Uint8Array[] = [];
  for (let k = 0; k < n; k++) {
    const len = readLen();
    if (len === undefined || i + len > b.length) return undefined;
    items.push(b.slice(i, i + len));
    i += len;
  }
  return i === b.length ? items : undefined;
}

function verifyBip322(addr: Addr, message: string, raw: Uint8Array): boolean {
  const w = parseWitness(raw);
  if (!w) return false;
  const prev = toSpendTxid(message, addr.script);
  try {
    if (addr.type === 'p2wpkh') {
      if (w.length !== 2 || w[1].length !== 33 || !eq(hash160(w[1]), addr.hash)) return false;
      const der = w[0];
      if (der[der.length - 1] !== 0x01) return false; // SIGHASH_ALL only
      return secp256k1.verify(der.slice(0, -1), segwitV0Sighash(prev, addr.hash), w[1], { prehash: false, format: 'der' });
    }
    if (addr.type === 'p2tr') {
      if (w.length !== 1) return false;
      const s = w[0];
      if (s.length === 64) return schnorr.verify(s, taprootSighash(prev, addr.script, 0), addr.hash);
      if (s.length === 65 && s[64] === 0x01) return schnorr.verify(s.slice(0, 64), taprootSighash(prev, addr.script, 1), addr.hash);
    }
  } catch {
    return false;
  }
  return false;
}

/** Does `signature` (base64, BIP-137 or BIP-322 simple) sign `message` for `address`? */
export function verifyMessage(address: string, message: string, signature: string): boolean {
  const addr = parseAddress(address);
  const sig = fromBase64(signature);
  if (typeof addr === 'string' || !sig) return false;
  if (sig.length === 65 && sig[0] >= 27 && sig[0] <= 42) return verifyBip137(addr, message, sig);
  return verifyBip322(addr, message, sig);
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ challenge (stateless: HMAC over address + expiry)

export const CHALLENGE_TTL_MS = 30 * 60_000;

/** One ASCII line (hardware wallets and Electrum mangle newlines). */
export function challengeFor(secret: string, address: string, expiresAt: number, label = 'Sats4Tokens trial key'): string {
  const exp = new Date(expiresAt).toISOString().slice(0, 16) + 'Z';
  const nonce = createHmac('sha256', secret).update(`challenge|${address}|${exp}`).digest('hex').slice(0, 16);
  return `${label} for ${address} nonce ${nonce} expires ${exp}`;
}

/** Was `message` issued by us for `address` and is it still valid? */
export function checkChallenge(secret: string, address: string, message: string, now: number, label?: string): string | undefined {
  const m = message.match(/ expires (\d{4}-\d\d-\d\dT\d\d:\d\dZ)$/);
  if (!m) return 'this is not the message we gave you: ask for a new one';
  const exp = Date.parse(m[1]);
  if (challengeFor(secret, address, exp, label) !== message) return 'this is not the message we gave you: ask for a new one';
  if (exp < now) return 'the message expired: ask for a new one';
  return undefined;
}

/** What we store per claimed address: an HMAC, so the ledger never holds the address itself. */
export const addressTag = (secret: string, address: string) =>
  createHmac('sha256', secret).update(`claimed|${address.trim().toLowerCase()}`).digest('hex').slice(0, 32);

// ------------------------------------------------------------------ balance at the snapshot (Esplora)

export interface Utxo { txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }

/** Sats in UTXOs confirmed at or before `snapshot` that are still unspent. */
export const heldSince = (utxos: Utxo[], snapshot: number): number =>
  utxos.reduce((s, u) => (u.status.confirmed && u.status.block_height !== undefined && u.status.block_height <= snapshot ? s + u.value : s), 0);

export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class Esplora {
  base: string;
  fetch: Fetch;
  private tip?: { h: number; at: number };
  constructor(base: string, f: Fetch = fetch as unknown as Fetch) {
    this.base = base.replace(/\/$/, '');
    this.fetch = f;
  }
  private async get(p: string): Promise<string> {
    const r = await this.fetch(this.base + p, { signal: AbortSignal.timeout(10_000) });
    const t = await r.text();
    if (!r.ok) throw new Error(r.status === 400 && /too many/i.test(t) ? 'this address has too many coins to look up' : `block explorer: HTTP ${r.status}`);
    return t;
  }
  async tipHeight(now = Date.now()): Promise<number> {
    if (this.tip && now - this.tip.at < 60_000) return this.tip.h;
    const h = Number(await this.get('/blocks/tip/height'));
    if (!Number.isInteger(h) || h <= 0) throw new Error('block explorer: bad tip height');
    this.tip = { h, at: now };
    return h;
  }
  async utxos(address: string): Promise<Utxo[]> {
    const u = JSON.parse(await this.get(`/address/${encodeURIComponent(address)}/utxo`)) as Utxo[];
    if (!Array.isArray(u)) throw new Error('block explorer: bad answer');
    return u;
  }
}

// ------------------------------------------------------------------ settings

export interface ProofSettings {
  snapshot: number; // block height: coins must be confirmed at or before it
  minSats: number;
  grantUsd: number; // key value in USD, converted to FIAT when a key is made
  maxClaims: number; // total
  perDay: number; // rolling 24 h
  esplora: string;
}

/** Off unless PROOF_SNAPSHOT_HEIGHT is set. */
export function proofFromEnv(env: Record<string, string | undefined>): ProofSettings | undefined {
  if (!env.PROOF_SNAPSHOT_HEIGHT) return undefined;
  const s: ProofSettings = {
    snapshot: Number(env.PROOF_SNAPSHOT_HEIGHT),
    minSats: Number(env.PROOF_MIN_SATS ?? 1_000_000),
    grantUsd: Number(env.PROOF_GRANT_USD ?? 1),
    maxClaims: Number(env.PROOF_MAX_CLAIMS ?? 50),
    perDay: Number(env.PROOF_PER_DAY ?? 20),
    esplora: env.PROOF_ESPLORA ?? 'https://mempool.space/api',
  };
  for (const [k, v] of Object.entries(s)) if (k !== 'esplora' && !(Number.isFinite(v) && (v as number) > 0)) throw new Error(`PROOF_*: bad ${k}`);
  if (!Number.isInteger(s.snapshot)) throw new Error('PROOF_SNAPSHOT_HEIGHT must be a block height');
  if (s.grantUsd > 10) throw new Error('PROOF_GRANT_USD above 10: on purpose? (cap in btcproof.ts)');
  return s;
}

/** Claims so far: total and in the last 24 h. */
export function claimCounts(claims: { at: number }[], now: number): { total: number; today: number } {
  return { total: claims.length, today: claims.filter((c) => c.at > now - 86_400_000).length };
}

// ------------------------------------------------------------------ the claim desk (server glue, testable)

export interface DeskDeps {
  settings: ProofSettings;
  data: () => LedgerData;
  save: () => void;
  esplora: Esplora;
  now: () => number;
  usdPerFiat: () => Promise<number>; // USD per 1 unit of the shop's FIAT
  /**
   * Under the shop's order lock: pool check, then a new key order worth `money` FIAT; `commit` may throw (then nothing
   * is saved) or turn it into a paid order; the caller saves it with the claim in one write. Or why not (pool).
   */
  makeKey: (money: string, commit: (o: Order) => void) => Promise<Order | string>;
}

export class ClaimError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ProofDesk {
  d: DeskDeps;
  private lookups: Promise<unknown> = Promise.resolve();
  constructor(d: DeskDeps) {
    this.d = d;
  }

  private store() {
    const data = this.d.data();
    if (!data.proof) {
      data.proof = { secret: randomBytes(32).toString('hex'), claims: [] };
      this.d.save();
    }
    return data.proof;
  }

  /** What the claim page shows before anyone signs. */
  info() {
    const s = this.d.settings;
    const c = claimCounts(this.d.data().proof?.claims ?? [], this.d.now());
    return {
      enabled: true, snapshot: s.snapshot, minSats: s.minSats, grantUsd: s.grantUsd, total: s.maxClaims,
      left: Math.max(0, s.maxClaims - c.total), leftToday: Math.max(0, Math.min(s.maxClaims - c.total, s.perDay - c.today)),
    };
  }

  challenge(address: unknown): { address: string; message: string; expiresAt: number } {
    const a = normalizeAddress(String(address ?? ''));
    const p = parseAddress(a);
    if (typeof p === 'string') throw new ClaimError(400, p);
    const message = challengeFor(this.store().secret, a, this.d.now() + CHALLENGE_TTL_MS);
    return { address: a, message, expiresAt: Date.parse(message.slice(-17)) };
  }

  private checkLimits(tag: string) {
    const s = this.d.settings;
    const claims = this.store().claims;
    if (claims.some((c) => c.tag === tag)) throw new ClaimError(409, 'this address already claimed its trial key');
    const c = claimCounts(claims, this.d.now());
    if (c.total >= s.maxClaims) throw new ClaimError(410, 'all trial keys are gone');
    if (c.today >= s.perDay) throw new ClaimError(429, "today's trial keys are gone: try again tomorrow");
  }

  /** Signature → balance at the snapshot → one PAID trial key order. Throws ClaimError with what to tell the user. */
  async claim(b: { address?: unknown; message?: unknown; signature?: unknown; ref?: unknown }): Promise<Order> {
    const s = this.d.settings;
    const address = normalizeAddress(String(b.address ?? ''));
    const message = String(b.message ?? '');
    const signature = String(b.signature ?? '').trim();
    const { secret } = this.store();
    const bad = checkChallenge(secret, address, message, this.d.now());
    if (bad) throw new ClaimError(400, bad);
    const tag = addressTag(secret, address);
    this.checkLimits(tag);
    if (!verifyMessage(address, message, signature)) {
      throw new ClaimError(400, "the signature doesn't match this address and message: sign the exact message with this address's key");
    }
    // one block explorer lookup at a time (public APIs rate-limit), and only after the cheap local checks
    const run = this.lookups.then(async () => {
      const tip = await this.d.esplora.tipHeight(this.d.now());
      if (tip < s.snapshot) throw new ClaimError(503, `claims open at block ${s.snapshot}`);
      return heldSince(await this.d.esplora.utxos(address), s.snapshot);
    });
    this.lookups = run.catch(() => {});
    let held: number;
    try {
      held = await run;
    } catch (e) {
      if (e instanceof ClaimError) throw e;
      throw new ClaimError(502, `couldn't read the address balance (${(e as Error).message}): try again in a minute`);
    }
    if (held < s.minSats) {
      throw new ClaimError(403, `this address holds ${held.toLocaleString('en')} sat in coins it already had at block ${s.snapshot}; ` +
        `the trial needs ${s.minSats.toLocaleString('en')} sat (coins received after that block don't count)`);
    }
    let rate: number;
    try {
      rate = await this.d.usdPerFiat();
      if (!(rate > 0)) throw new Error('bad rate');
    } catch {
      throw new ClaimError(503, 'exchange rate unavailable: try again in a minute');
    }
    const money = (s.grantUsd / rate).toFixed(2);
    const order = await this.d.makeKey(money, (o) => {
      this.checkLimits(tag); // again, under the order lock: two tabs claiming at once get one key
      this.store().claims.push({ tag, at: this.d.now() });
      o.state = 'PAID';
      o.sats = 0;
      o.paid = { at: this.d.now(), via: 'proof', sats: 0, fee: 0 };
      o.name = `Trial key · $${s.grantUsd} for a bitcoin holder`;
      o.ref = 'proof-' + cleanRef(b.ref); // the funnel keeps trial keys apart from paid ones, per channel
    });
    if (typeof order === 'string') throw new ClaimError(503, order);
    return order;
  }
}

export { bytesToHex, hexToBytes };
