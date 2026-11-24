/**
 * Local store interface. The UI reads and writes only through this; sync runs in the background.
 * The real implementation (SQLite via the native shell, in-memory/OPFS in browser tests) comes later
 * per ADR-0007; apps depend on this interface only.
 */

/** Every tenant-owned row carries tenant_id (the organisation) and its own id. */
export type Row = {
  id: string;
  tenant_id: string;
  /** Tombstone marker: deletes sync like any operation, so rows are marked, not removed. */
  deleted?: boolean;
  [field: string]: unknown;
};

export interface StoreTx {
  get(entity: string, id: string): Row | undefined;
  /** Live (not tombstoned) rows of an entity. */
  list(entity: string): Row[];
  /** Insert or replace. Throws if `row.tenant_id` is not this store's tenant. */
  put(entity: string, row: Row): void;
  /** Tombstone the row. */
  del(entity: string, id: string): void;
}

export interface LocalStore {
  /** Tenant this store is scoped to. A store never returns another tenant's rows. */
  readonly tenantId: string;
  get(entity: string, id: string): Promise<Row | undefined>;
  list(entity: string): Promise<Row[]>;
  /**
   * Single-writer transaction: runs serially after earlier transactions, commits all changes or,
   * if `fn` throws, none. Op allocation, row changes and counters happen inside one transaction
   * (ADR-0002 S4).
   */
  transact<T>(fn: (tx: StoreTx) => T | Promise<T>): Promise<T>;
}
