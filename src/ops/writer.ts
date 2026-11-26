import type { SyncEngine, SyncRunner, RecordSpec } from "../sync";
import { IntentError, intentDef, streamKindOf, validateOp } from "./intents";
import type { Delivery, OpWriter, RecordedOp, SyncPort, SyncView } from "./ports";

export type EngineOpWriterOptions = {
  /** Streams for intents that are not outlet-scoped (`brand:<id>`, `tenant:<id>`). The outlet stream is the engine's. */
  streams?: { brand?: string; tenant?: string };
  /** Check every op against the intent registry before it is recorded. Default true; turn off only to replay old data. */
  validate?: boolean;
};

/**
 * The app's `OpWriter` over the sync engine. One call is one local transaction: the legal numbers (one, or several for
 * a re-bill), the row changes and the op commit together or not at all. Before commit the op is checked against its
 * intent (entities, mutation kinds, fields, which numbers it may take), so a builder that drifts from the contract
 * fails here, on the device, instead of being quarantined by the gateway.
 */
export class EngineOpWriter implements OpWriter {
  constructor(
    private readonly engine: SyncEngine,
    private readonly o: EngineOpWriterOptions = {},
  ) {}

  async record(spec: RecordSpec): Promise<RecordedOp> {
    const validate = this.o.validate ?? true;
    const def = validate ? intentDef(spec.intent) : undefined;
    const stream = spec.stream ?? this.streamFor(spec.intent, validate);
    const taken: string[] = [];
    const op = await this.engine.record({
      ...spec,
      ...(def && spec.intentV === undefined ? { intentV: def.v } : {}),
      ...(stream ? { stream } : {}),
      build: (ctx) => {
        const muts = spec.build({
          ...ctx,
          number: (t) => {
            taken.push(t);
            return ctx.number(t);
          },
        });
        if (validate) validateOp(spec.intent, muts, taken); // throwing here rolls the whole transaction back, numbers included
        return muts;
      },
    });
    return op;
  }

  private streamFor(intent: string, validate: boolean): string | undefined {
    if (!validate) return undefined;
    const kind = streamKindOf(intent);
    if (kind === "outlet") return undefined;
    const s = this.o.streams?.[kind as "brand" | "tenant"];
    if (!s) throw new IntentError("stream_not_configured", `${intent} is recorded on the ${kind} stream; none is configured`);
    return s;
  }
}

/** Joins the runner (background rounds, status) and the engine (delivery of own ops) into the app's `SyncPort`. */
export function createSyncPort(runner: SyncRunner, engine: SyncEngine): SyncPort {
  return {
    start: () => runner.start(),
    stop: () => runner.stop(),
    syncNow: () => runner.syncNow(),
    status: (): SyncView => runner.status(),
    onStatus: (l) => runner.onStatus(l),
    delivery: (seq): Delivery => engine.delivery(seq),
  };
}
