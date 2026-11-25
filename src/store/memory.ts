import type { LocalStore, Row, StoreTx } from "./types";

type Tables = Map<string, Map<string, Row>>;

/** Durable backing for a store: loaded once at open, then each committed transaction is written as one batch. */
export interface Persistence {
  load(): Promise<Array<[entity: string, row: Row]>>;
  /** Atomic: all rows of the batch are stored or none. */
  commit(writes: Array<[entity: string, row: Row]>): Promise<void>;
}

/**
 * LocalStore with the working set in memory. Transactions are copy-on-write (a write overlay, not a
 * clone of every table), so cost is proportional to what a transaction touches. With a `Persistence`
 * the committed overlay is written before it becomes visible, so a crash before commit loses the
 * whole transaction and never half of it. Used for unit tests and browser-only runs.
 */
export class InMemoryStore implements LocalStore {
  private tables: Tables = new Map();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly tenantId: string,
    private readonly persistence?: Persistence,
  ) {}

  /** Opens a store over a persistence, loading its rows. Rows of another tenant are never loaded. */
  static async open(tenantId: string, persistence: Persistence): Promise<InMemoryStore> {
    const store = new InMemoryStore(tenantId, persistence);
    for (const [entity, row] of await persistence.load()) {
      if (row.tenant_id === tenantId) store.table(store.tables, entity).set(row.id, row);
    }
    return store;
  }

  async get(entity: string, id: string): Promise<Row | undefined> {
    return this.read(this.tables, undefined, entity, id);
  }

  async list(entity: string): Promise<Row[]> {
    return this.readAll(this.tables, undefined, entity);
  }

  transact<T>(fn: (tx: StoreTx) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const overlay: Tables = new Map();
      const tx: StoreTx = {
        get: (entity, id) => this.read(this.tables, overlay, entity, id),
        list: (entity) => this.readAll(this.tables, overlay, entity),
        put: (entity, row) => {
          if (row.tenant_id !== this.tenantId) {
            throw new Error("tenant mismatch: row does not belong to this store's tenant");
          }
          this.table(overlay, entity).set(row.id, structuredClone(row));
        },
        del: (entity, id) => {
          const row = this.table(overlay, entity).get(id) ?? this.tables.get(entity)?.get(id);
          if (row) this.table(overlay, entity).set(id, { ...structuredClone(row), deleted: true });
        },
      };
      const result = await fn(tx);
      const writes: Array<[string, Row]> = [];
      for (const [entity, rows] of overlay) for (const row of rows.values()) writes.push([entity, row]);
      if (this.persistence && writes.length > 0) await this.persistence.commit(writes);
      for (const [entity, row] of writes) this.table(this.tables, entity).set(row.id, row); // commit
      return result;
    };
    // Serialise: each transaction starts after the previous one settles, whether it committed or not.
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private table(tables: Tables, entity: string): Map<string, Row> {
    let t = tables.get(entity);
    if (!t) tables.set(entity, (t = new Map()));
    return t;
  }

  private read(base: Tables, overlay: Tables | undefined, entity: string, id: string): Row | undefined {
    const row = overlay?.get(entity)?.get(id) ?? base.get(entity)?.get(id);
    // Tenant check on read as well: a row of another tenant is "not found", never an error.
    return row && row.tenant_id === this.tenantId ? structuredClone(row) : undefined;
  }

  private readAll(base: Tables, overlay: Tables | undefined, entity: string): Row[] {
    const merged = new Map(base.get(entity));
    for (const [id, row] of overlay?.get(entity) ?? []) merged.set(id, row);
    return [...merged.values()]
      .filter((r) => r.tenant_id === this.tenantId && !r.deleted)
      .map((r) => structuredClone(r));
  }
}
