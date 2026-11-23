// Minimal in-memory stand-in for the supabase-js query builder — enough to run the real route code.
type Row = Record<string, any>;
type Filter = (r: Row) => boolean;

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

let idCounter = 0;
const nextUuid = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;

export class FakeDb {
  tables: Record<string, Row[]> = {};
  rpcHandlers: Record<string, (args: any) => any> = {};
  rpcCalls: { name: string; args: any }[] = [];
  /** Embedded-select resolvers: relations[table][embedName](row) */
  relations: Record<string, Record<string, (row: Row) => Row | Row[] | null>> = {};
  auth = { admin: { signOut: async () => ({}), createUser: async () => ({}), deleteUser: async () => ({}) } };

  constructor() {
    const self = this;
    const owner = (row: Row) => self.rows('profiles').find((p) => p.id === row.user_id) ?? null;
    for (const t of ['investments', 'account_upgrades', 'withdrawals', 'loans']) this.relations[t] = { profiles: owner };
    this.relations.loans.loan_timeline = (row) => self.rows('loan_timeline').filter((e) => e.loan_id === row.id);
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }
  seed(table: string, rows: Row[]) {
    this.rows(table).push(...rows.map((r) => ({ ...r })));
    return this;
  }
  onRpc(name: string, fn: (args: any) => any) {
    this.rpcHandlers[name] = fn;
    return this;
  }

  from(table: string) {
    return new Query(this, table);
  }

  rpc(name: string, args: any = {}) {
    this.rpcCalls.push({ name, args });
    const run = async () => {
      const h = this.rpcHandlers[name];
      if (!h) return { data: null, error: { message: `unhandled rpc ${name}` } };
      try {
        const data = await h(args);
        return { data: data ?? null, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    };
    return { then: (res: any, rej: any) => run().then(res, rej) } as any;
  }
}

class Query {
  private op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private filters: Filter[] = [];
  private cols = '*';
  private payload: any;
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private count: 'exact' | null = null;
  private head = false;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  private returning = false;
  private onConflict?: string;

  constructor(private db: FakeDb, private table: string) {}

  select(cols = '*', opts?: { count?: 'exact'; head?: boolean }) {
    if (this.op !== 'select') this.returning = true;
    this.cols = cols;
    if (opts?.count) this.count = opts.count;
    if (opts?.head) this.head = true;
    return this;
  }
  insert(v: any) { this.op = 'insert'; this.payload = v; return this; }
  update(v: any) { this.op = 'update'; this.payload = v; return this; }
  upsert(v: any, o?: { onConflict?: string }) { this.op = 'upsert'; this.payload = v; this.onConflict = o?.onConflict; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: any) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: any[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: any) { this.filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return this; }
  lt(c: string, v: any) { this.filters.push((r) => Number(r[c]) < Number(v)); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  single() { this.mode = 'single'; return this; }

  private project(row: Row): Row {
    if (this.cols === '*') return { ...row };
    const out: Row = {};
    for (const token of splitTopLevel(this.cols)) {
      const m = token.match(/^(\w+)\((.*)\)$/);
      if (m) {
        const resolver = this.db.relations[this.table]?.[m[1]];
        const rel = resolver ? resolver(row) : null;
        const pick = (r: Row) => Object.fromEntries(splitTopLevel(m[2]).map((c) => [c, r[c]]));
        out[m[1]] = Array.isArray(rel) ? rel.map(pick) : rel ? pick(rel) : null;
      } else out[token] = row[token];
    }
    return out;
  }

  private async exec() {
    const rows = this.db.rows(this.table);
    const match = (r: Row) => this.filters.every((f) => f(r));
    let result: Row[] = [];
    let total: number | null = null;

    if (this.op === 'insert' || this.op === 'upsert') {
      const items: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const item of items) {
        const row = { ...item };
        if (this.op === 'upsert' && this.onConflict) {
          const idx = rows.findIndex((r) => r[this.onConflict!] === row[this.onConflict!]);
          if (idx >= 0) { rows[idx] = { ...rows[idx], ...row }; result.push(rows[idx]); continue; }
        }
        if (row.id === undefined && !['config', 'push_tokens'].includes(this.table)) row.id = nextUuid();
        rows.push(row);
        result.push(row);
      }
    } else if (this.op === 'update') {
      for (const r of rows) if (match(r)) { Object.assign(r, this.payload); result.push(r); }
    } else if (this.op === 'delete') {
      for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i])) result.push(...rows.splice(i, 1));
    } else {
      result = rows.filter(match);
      total = result.length;
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        result = [...result].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      if (this.max !== null) result = result.slice(0, this.max);
    }

    const returnsRows = this.op === 'select' || this.returning;
    const projected = returnsRows ? result.map((r) => this.project(r)) : null;

    if (this.head) return { data: null, error: null, count: total };
    if (this.mode === 'single') {
      if (!projected || projected.length !== 1) return { data: null, error: { message: 'single row expected' } };
      return { data: projected[0], error: null };
    }
    if (this.mode === 'maybe') {
      if (projected && projected.length > 1) return { data: null, error: { message: 'multiple rows' } };
      return { data: projected?.[0] ?? null, error: null };
    }
    return { data: projected, error: null, count: this.count ? total : undefined };
  }

  then(res: any, rej: any) {
    return this.exec().then(res, rej);
  }
}
