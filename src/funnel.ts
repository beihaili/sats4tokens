// Funnel counting for the shop: homepage views per day and per `?ref=` (which post someone came from), joined with
// the ledger's orders and payments. No IP, no cookie, nothing per person: the homepage sends one beacon per load
// (POST /api/hit {ref, first}), `first` = this browser's first visit (a flag in its own localStorage). Bots that
// don't run JS (link previews, crawlers) never send it. Counts are not proof against someone inflating them.
import fs from 'node:fs';
import path from 'node:path';
import type { Order } from './ledger.ts';

export interface DayCounts {
  views: number;
  visitors: number; // first visits
}
interface Stats {
  days: Record<string, Record<string, DayCounts>>; // 'YYYY-MM-DD' (UTC) → ref → counts
}

const KEEP_DAYS = 120;
const MAX_REFS_PER_DAY = 50;

/** A ref as it may be stored: short, lowercase [a-z0-9_-]; none → 'direct', anything else → 'other'. */
export function cleanRef(ref: unknown): string {
  const r = String(ref ?? '').trim().toLowerCase();
  if (!r) return 'direct';
  return /^[a-z0-9_-]{1,24}$/.test(r) ? r : 'other';
}

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface FunnelRow {
  day: string;
  ref: string;
  views: number;
  visitors: number;
  orders: number; // key shop orders made (new keys + manual top-ups; auto top-ups are ref 'auto')
  paid: number;
  money: number; // FIAT paid (without bonus)
}

export class Funnel {
  file: string;
  data: Stats;
  private dirty = false;

  constructor(file: string) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8')) as Stats;
    } catch {
      this.data = { days: {} };
    }
  }

  hit(ref: string, first: boolean, now: number): void {
    const day = (this.data.days[dayOf(now)] ??= {});
    if (!day[ref] && Object.keys(day).length >= MAX_REFS_PER_DAY) ref = 'other';
    const c = (day[ref] ??= { views: 0, visitors: 0 });
    c.views++;
    if (first) c.visitors++;
    this.dirty = true;
  }

  /** Write if anything changed (called every minute and on shutdown; losing a minute of counts is fine). */
  flush(now = Date.now()): void {
    if (!this.dirty) return;
    const oldest = dayOf(now - KEEP_DAYS * 86400_000);
    for (const d of Object.keys(this.data.days)) if (d < oldest) delete this.data.days[d];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data));
    fs.renameSync(this.file + '.tmp', this.file);
    this.dirty = false;
  }

  /** Last `days` days, newest first: one row per (day, ref) that had views or key shop orders. */
  report(orders: Order[], days: number, now: number): FunnelRow[] {
    const from = dayOf(now - (days - 1) * 86400_000);
    const rows = new Map<string, FunnelRow>();
    const row = (day: string, ref: string) => {
      const k = day + ' ' + ref;
      let r = rows.get(k);
      if (!r) rows.set(k, (r = { day, ref, views: 0, visitors: 0, orders: 0, paid: 0, money: 0 }));
      return r;
    };
    for (const [day, refs] of Object.entries(this.data.days)) {
      if (day < from) continue;
      for (const [ref, c] of Object.entries(refs)) Object.assign(row(day, ref), { views: c.views, visitors: c.visitors });
    }
    for (const o of orders) {
      if (o.kind !== 'key' && o.kind !== 'keytopup') continue;
      const day = dayOf(o.createdAt);
      if (day < from) continue;
      const r = row(day, o.ref ?? 'direct');
      r.orders++;
      if (o.state === 'PAID') {
        r.paid++;
        r.money += Number(o.money);
      }
    }
    return [...rows.values()].sort((a, b) => b.day.localeCompare(a.day) || b.views - a.views || a.ref.localeCompare(b.ref));
  }
}
