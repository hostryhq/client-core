import type { LocalStore, Row, StoreTx } from "./types";

type Tables = Map<string, Map<string, Row>>;

function cloneTables(src: Tables): Tables {
  const out: Tables = new Map();
  for (const [entity, rows] of src) {
    out.set(entity, new Map([...rows].map(([id, row]) => [id, structuredClone(row)])));
  }
  return out;
}

/** In-memory LocalStore for unit tests and browser-only runs. Not durable. */
export class InMemoryStore implements LocalStore {
  private tables: Tables = new Map();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly tenantId: string) {}

  async get(entity: string, id: string): Promise<Row | undefined> {
    return this.read(this.tables, entity, id);
  }

  async list(entity: string): Promise<Row[]> {
    return this.readAll(this.tables, entity);
  }

  transact<T>(fn: (tx: StoreTx) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const working = cloneTables(this.tables);
      const tx: StoreTx = {
        get: (entity, id) => this.read(working, entity, id),
        list: (entity) => this.readAll(working, entity),
        put: (entity, row) => {
          if (row.tenant_id !== this.tenantId) {
            throw new Error("tenant mismatch: row does not belong to this store's tenant");
          }
          this.table(working, entity).set(row.id, structuredClone(row));
        },
        del: (entity, id) => {
          const row = this.table(working, entity).get(id);
          if (row) this.table(working, entity).set(id, { ...row, deleted: true });
        },
      };
      const result = await fn(tx);
      this.tables = working; // commit
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

  private read(tables: Tables, entity: string, id: string): Row | undefined {
    const row = tables.get(entity)?.get(id);
    // Tenant check on read as well: a row of another tenant is "not found", never an error.
    return row && row.tenant_id === this.tenantId ? structuredClone(row) : undefined;
  }

  private readAll(tables: Tables, entity: string): Row[] {
    return [...(tables.get(entity)?.values() ?? [])]
      .filter((r) => r.tenant_id === this.tenantId && !r.deleted)
      .map((r) => structuredClone(r));
  }
}
