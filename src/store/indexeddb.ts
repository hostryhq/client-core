import type { Persistence } from "./memory";
import type { Row } from "./types";

const STORE = "rows";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb request failed"));
  });
}

/**
 * Browser persistence over the raw IndexedDB API (no dependency): one object store keyed by
 * [entity, id]. Use `InMemoryStore.open(tenantId, await IndexedDbPersistence.open(name))`. A committed
 * transaction is one IndexedDB readwrite transaction, so it is stored whole or not at all.
 * The working set is held in memory (fine for the PoC; the native shell uses SQLite, ADR-0007).
 */
export class IndexedDbPersistence implements Persistence {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name: string, factory: IDBFactory = indexedDB): Promise<IndexedDbPersistence> {
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: ["entity", "id"] });
    return new IndexedDbPersistence(await request(req));
  }

  async load(): Promise<Array<[string, Row]>> {
    const all = await request(this.db.transaction(STORE, "readonly").objectStore(STORE).getAll());
    return (all as Array<{ entity: string; id: string; row: Row }>).map((r) => [r.entity, r.row]);
  }

  commit(writes: Array<[string, Row]>): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, "readwrite");
      const os = tx.objectStore(STORE);
      for (const [entity, row] of writes) os.put({ entity, id: row.id, row });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("indexeddb commit failed"));
      tx.onabort = () => reject(tx.error ?? new Error("indexeddb commit aborted"));
    });
  }

  close(): void {
    this.db.close();
  }
}
