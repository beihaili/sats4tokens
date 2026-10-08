// Nostr Wallet Connect (NIP-47) client: just enough to ask a customer's wallet to pay one invoice.
//
// A connection string `nostr+walletconnect://<wallet pubkey>?relay=wss://…&secret=<hex>` is a spending credential
// for the customer's wallet (up to the budget they set there): BEARER, never log it or send it back to a page.
// Requests are kind 23194 events, encrypted to the wallet with NIP-44 v2 (or NIP-04 when the wallet's info event
// doesn't list nip44_v2), signed with the connection's secret; the wallet answers with kind 23195 tagged with the
// request's id. Crypto comes from @noble/curves + @noble/hashes (already there for cashu-ts) and node:crypto.
//
// payInvoice sends ONE request per call and never retries by itself: an answer can get lost after the wallet paid,
// so whether to ask again is the caller's decision (autotopup.ts: never for the same order).
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export interface NwcConnection {
  wallet: string; // wallet service pubkey (hex)
  relays: string[];
  secret: string; // client secret key (hex) — BEARER
}

/** Wallet errors (NIP-47 codes: INSUFFICIENT_BALANCE, QUOTA_EXCEEDED, …) and ours: TIMEOUT, RELAY, BAD_RESPONSE. */
export class NwcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Parse a connection string (nostr+walletconnect://, also nostrwalletconnect: as some wallets write it). */
export function parseNwc(uri: string): NwcConnection {
  const m = uri.trim().match(/^nostr\+?walletconnect:(?:\/\/)?([0-9a-fA-F]{64})\?(.+)$/);
  if (!m) throw new Error('not a Nostr Wallet Connect string (nostr+walletconnect://…)');
  const q = new URLSearchParams(m[2]);
  const secret = (q.get('secret') ?? '').toLowerCase();
  const relays = q.getAll('relay').map((r) => r.trim()).filter((r) => /^wss?:\/\/./.test(r));
  if (!HEX64.test(secret)) throw new Error('connection string has no valid secret');
  if (relays.length === 0) throw new Error('connection string has no relay');
  return { wallet: m[1].toLowerCase(), relays, secret };
}

export const publicKeyOf = (secret: string): string => bytesToHex(schnorr.getPublicKey(hexToBytes(secret)));

// ------------------------------------------------------------------ encryption

/** ECDH x coordinate between our secret and an x-only nostr pubkey. */
function sharedX(secret: string, pubkey: string): Uint8Array {
  return secp256k1.getSharedSecret(hexToBytes(secret), hexToBytes('02' + pubkey)).subarray(1, 33);
}

export function nip04Encrypt(secret: string, pubkey: string, text: string): string {
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-cbc', sharedX(secret, pubkey), iv);
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64') + '?iv=' + iv.toString('base64');
}

export function nip04Decrypt(secret: string, pubkey: string, payload: string): string {
  const [ct, iv] = payload.split('?iv=');
  const d = createDecipheriv('aes-256-cbc', sharedX(secret, pubkey), Buffer.from(iv ?? '', 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

const hmac = (key: Uint8Array, ...parts: Uint8Array[]) => {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
};

/** NIP-44 v2 conversation key = HKDF-extract(salt "nip44-v2", shared x). Same both ways. */
export const nip44ConversationKey = (secret: string, pubkey: string): Buffer => hmac(Buffer.from('nip44-v2'), sharedX(secret, pubkey));

/** HKDF-expand(conversation key, nonce, 76) → chacha key, chacha nonce, hmac key. */
function nip44Keys(conv: Uint8Array, nonce: Uint8Array) {
  let t = Buffer.alloc(0);
  let okm = Buffer.alloc(0);
  for (let i = 1; okm.length < 76; i++) {
    t = hmac(conv, t, nonce, Uint8Array.of(i));
    okm = Buffer.concat([okm, t]);
  }
  return { key: okm.subarray(0, 32), nonce: okm.subarray(32, 44), hmacKey: okm.subarray(44, 76) };
}

export function nip44PaddedLen(len: number): number {
  if (len <= 32) return 32;
  const next = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = next <= 256 ? 32 : next / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

// node's chacha20 takes a 16-byte iv: 4-byte little-endian block counter (0) + the 12-byte nonce
const chacha = (key: Uint8Array, nonce: Uint8Array, data: Uint8Array) =>
  createCipheriv('chacha20', key, Buffer.concat([Buffer.alloc(4), nonce])).update(data);

export function nip44Encrypt(conv: Uint8Array, text: string, nonce: Uint8Array = randomBytes(32)): string {
  const plain = Buffer.from(text, 'utf8');
  if (plain.length < 1 || plain.length > 65535) throw new Error('nip44: message length out of range');
  const padded = Buffer.alloc(2 + nip44PaddedLen(plain.length));
  padded.writeUInt16BE(plain.length, 0);
  plain.copy(padded, 2);
  const k = nip44Keys(conv, nonce);
  const ct = chacha(k.key, k.nonce, padded);
  return Buffer.concat([Uint8Array.of(2), nonce, ct, hmac(k.hmacKey, nonce, ct)]).toString('base64');
}

export function nip44Decrypt(conv: Uint8Array, payload: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw[0] !== 2 || raw.length < 99) throw new Error('nip44: unknown version or too short');
  const nonce = raw.subarray(1, 33);
  const ct = raw.subarray(33, raw.length - 32);
  const k = nip44Keys(conv, nonce);
  if (!timingSafeEqual(hmac(k.hmacKey, nonce, ct), raw.subarray(raw.length - 32))) throw new Error('nip44: bad mac');
  const padded = chacha(k.key, k.nonce, ct);
  const len = padded.readUInt16BE(0);
  if (len < 1 || 2 + nip44PaddedLen(len) !== padded.length) throw new Error('nip44: bad padding');
  return padded.subarray(2, 2 + len).toString('utf8');
}

// ------------------------------------------------------------------ events

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export function signEvent(secret: string, e: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>): NostrEvent {
  const pubkey = publicKeyOf(secret);
  const id = sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, e.created_at, e.kind, e.tags, e.content])));
  return { ...e, pubkey, id: bytesToHex(id), sig: bytesToHex(schnorr.sign(id, hexToBytes(secret))) };
}

export function verifyEvent(e: NostrEvent): boolean {
  try {
    const id = sha256(new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])));
    return bytesToHex(id) === e.id && schnorr.verify(hexToBytes(e.sig), id, hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ relay

/** A relay connection, as text frames. Tests plug in a fake; the default is Node's global WebSocket. */
export interface Socket {
  send(text: string): void;
  close(): void;
  onmessage?: (text: string) => void;
  onclose?: () => void;
}
export type Connect = (url: string, timeoutMs: number) => Promise<Socket>;

export const webSocketConnect: Connect = (url, timeoutMs) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const sock: Socket = { send: (t) => ws.send(t), close: () => ws.close() };
    const timer = setTimeout(() => {
      ws.close();
      reject(new NwcError('RELAY', `can't reach ${url}`));
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(sock);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new NwcError('RELAY', `can't reach ${url}`));
    };
    ws.onmessage = (ev) => sock.onmessage?.(String(ev.data));
    ws.onclose = () => sock.onclose?.();
  });

/** Messages from one relay, buffered so a wait that starts late still sees them. */
class Relay {
  private buf: any[][] = [];
  private waiters: Array<{ pred: (m: any[]) => boolean; done: (m?: any[]) => void }> = [];
  private closed = false;
  private sock: Socket;

  constructor(sock: Socket) {
    this.sock = sock;
    sock.onmessage = (text) => {
      let m: unknown;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      if (!Array.isArray(m)) return;
      const i = this.waiters.findIndex((w) => w.pred(m as any[]));
      if (i >= 0) this.waiters.splice(i, 1)[0].done(m as any[]);
      else this.buf.push(m as any[]);
    };
    sock.onclose = () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.done(undefined);
    };
  }

  send(msg: unknown[]): void {
    this.sock.send(JSON.stringify(msg));
  }

  /** The next message matching `pred`, or undefined after `ms` / when the relay closes. */
  next(pred: (m: any[]) => boolean, ms: number): Promise<any[] | undefined> {
    const i = this.buf.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.buf.splice(i, 1)[0]);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const w = {
        pred,
        done: (m?: any[]) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        resolve(undefined);
      }, ms);
      this.waiters.push(w);
    });
  }

  close(): void {
    this.sock.close();
  }
}

/** Run `fn` on the first relay of the connection that answers. */
async function withRelay<T>(c: NwcConnection, connect: Connect, fn: (r: Relay) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const url of c.relays) {
    let sock: Socket;
    try {
      sock = await connect(url, 8000);
    } catch (e) {
      last = e;
      continue;
    }
    const r = new Relay(sock);
    try {
      return await fn(r);
    } finally {
      r.close();
    }
  }
  throw last instanceof NwcError ? last : new NwcError('RELAY', `no relay reachable (${c.relays.join(', ')})`);
}

export interface WalletInfo {
  methods: string[];
  encryption: string[]; // "nip44_v2", "nip04"; a wallet that doesn't say speaks nip04
}

/** The wallet's info event (kind 13194), or undefined if the relay has none. */
async function readInfo(r: Relay, c: NwcConnection, ms: number): Promise<WalletInfo | undefined> {
  const sub = 'i' + randomBytes(4).toString('hex');
  r.send(['REQ', sub, { kinds: [13194], authors: [c.wallet], limit: 1 }]);
  const m = await r.next((m) => m[1] === sub && (m[0] === 'EVENT' || m[0] === 'EOSE' || m[0] === 'CLOSED'), ms);
  r.send(['CLOSE', sub]);
  const e = m?.[0] === 'EVENT' ? (m[2] as NostrEvent) : undefined;
  if (!e || e.pubkey !== c.wallet || e.kind !== 13194 || !verifyEvent(e)) return undefined;
  const enc = e.tags.find((t) => t[0] === 'encryption')?.[1];
  return { methods: e.content.split(/[\s,]+/).filter(Boolean), encryption: enc ? enc.split(/\s+/) : ['nip04'] };
}

/** What the wallet says it can do (for checking a connection when the customer saves it). */
export function walletInfo(c: NwcConnection, connect: Connect = webSocketConnect): Promise<WalletInfo | undefined> {
  return withRelay(c, connect, (r) => readInfo(r, c, 8000));
}

/**
 * Ask the wallet to pay `invoice`. Resolves with the preimage once the wallet says it paid; throws NwcError with the
 * wallet's code if it refused, TIMEOUT if no answer came (the payment may still have happened!), RELAY if no relay.
 */
export function payInvoice(
  c: NwcConnection,
  invoice: string,
  opts: { timeoutMs?: number; connect?: Connect; now?: () => number } = {},
): Promise<{ preimage: string; feesPaid?: number }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  return withRelay(c, opts.connect ?? webSocketConnect, async (r) => {
    const info = await readInfo(r, c, 5000);
    const nip44 = !!info?.encryption.includes('nip44_v2');
    const body = JSON.stringify({ method: 'pay_invoice', params: { invoice } });
    const content = nip44 ? nip44Encrypt(nip44ConversationKey(c.secret, c.wallet), body) : nip04Encrypt(c.secret, c.wallet, body);
    const t = now();
    const tags = [['p', c.wallet], ['expiration', String(t + Math.ceil(timeoutMs / 1000))]];
    if (nip44) tags.push(['encryption', 'nip44_v2']);
    const req = signEvent(c.secret, { created_at: t, kind: 23194, tags, content });

    // subscribe to the answer before sending, so it can't slip past us
    const sub = 'r' + randomBytes(4).toString('hex');
    r.send(['REQ', sub, { kinds: [23195], authors: [c.wallet], '#e': [req.id] }]);
    await r.next((m) => m[1] === sub && (m[0] === 'EOSE' || m[0] === 'CLOSED'), 3000);
    r.send(['EVENT', req]);
    const ok = await r.next((m) => m[0] === 'OK' && m[1] === req.id, 10_000);
    if (ok && ok[2] === false) throw new NwcError('RELAY', `relay refused the request: ${ok[3] ?? ''}`);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = await r.next((m) => m[0] === 'EVENT' && m[1] === sub, Math.max(0, deadline - Date.now()));
      if (!m) throw new NwcError('TIMEOUT', `no answer from the wallet within ${Math.round(timeoutMs / 1000)}s`);
      const e = m[2] as NostrEvent;
      if (e.pubkey !== c.wallet || e.kind !== 23195 || !verifyEvent(e) || !e.tags.some((t) => t[0] === 'e' && t[1] === req.id)) continue;
      let res: any;
      try {
        const text = e.content.includes('?iv=')
          ? nip04Decrypt(c.secret, c.wallet, e.content)
          : nip44Decrypt(nip44ConversationKey(c.secret, c.wallet), e.content);
        res = JSON.parse(text);
      } catch (err) {
        throw new NwcError('BAD_RESPONSE', `can't read the wallet's answer (${(err as Error).message})`);
      }
      if (res?.error) throw new NwcError(String(res.error.code ?? 'OTHER'), String(res.error.message ?? ''));
      if (!res?.result?.preimage) throw new NwcError('BAD_RESPONSE', 'answer without a preimage');
      return { preimage: String(res.result.preimage), feesPaid: res.result.fees_paid };
    }
  });
}
