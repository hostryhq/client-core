import {
  allocatorFromFn,
  billMutations,
  creditNoteMutations,
  finalizeBill,
  issueCreditNote,
  manualBookEntry,
  presentCheck,
  rebill,
  rebillMutations,
  type BillableLine,
  type BillLineRow,
  type BillRow,
  type CheckHeader,
  type CreditNoteResult,
  type CreditRequest,
  type DocumentDeps,
  type DocumentNumberAllocator,
  type FinalizedBill,
  type FinalizeOptions,
  type ManualEntryInput,
  type OriginalBill,
  type OutletBillingContext,
  type PaymentInput,
  type PaymentRow,
  type PresentOptions,
  type RebillResult,
  type RefundTender,
  type Replacement,
  type TaxLineRow,
  DocumentError,
} from "../documents";
import type { Row } from "../store";
import type { BuildCtx, Mutation, RecordSpec } from "../sync";

/**
 * Intent builders for documents: each turns one till action into the `RecordSpec` of its sync intent. The document
 * functions run inside the op's build step, so the legal numbers come from the engine's series allocator in the same
 * local transaction as the op (ADR-0002 S7), and a build that throws leaves no number burnt.
 */

/** Wires the documents' allocator interface to the engine's allocator for one op. Several calls take several numbers. */
export const allocatorForOp = (ctx: Pick<BuildCtx, "number">): DocumentNumberAllocator => allocatorFromFn((docType) => ctx.number(docType));

/** What the device knows about the outlet at the time of the action. */
export type DocumentEnv = {
  outlet: OutletBillingContext;
  /** Business days this device knows, to stamp the document. */
  businessDays: DocumentDeps["businessDays"];
};

const depsFor = (env: DocumentEnv, ctx: BuildCtx): DocumentDeps => ({ allocator: allocatorForOp(ctx), newId: () => ctx.newId(), nowMs: ctx.now, businessDays: env.businessDays });

/** Optional hooks shared by every builder. */
type Common<R> = {
  approval?: string;
  /** Called inside the build step with the full result (for printing); it is not called again on replay. */
  onBuilt?: (r: R) => void;
};

const spec = <R>(intent: string, a: Common<R>, build: (ctx: BuildCtx) => { muts: Mutation[]; result: R }): RecordSpec => ({
  intent,
  ...(a.approval ? { approval: a.approval } : {}),
  build: (ctx) => {
    const { muts, result } = build(ctx);
    a.onBuilt?.(result);
    return muts;
  },
});

/** bill.finalize: the numbered bill, its lines, tax lines and payments, and the check marked billed. One number. */
export function finalizeBillSpec(a: Common<FinalizedBill> & { env: DocumentEnv; header: CheckHeader; lines: readonly BillableLine[]; options?: FinalizeOptions }): RecordSpec {
  return spec("bill.finalize", a, (ctx) => {
    const f = finalizeBill(depsFor(a.env, ctx), a.env.outlet, a.header, a.lines, a.options);
    return { muts: billMutations(f), result: f };
  });
}

/** bill.manual_entry: a paper-book page typed in; the book keeps its own number, so nothing is allocated. */
export function manualEntrySpec(a: Common<FinalizedBill & { matchesBook: boolean }> & { env: DocumentEnv; input: ManualEntryInput }): RecordSpec {
  return spec("bill.manual_entry", a, (ctx) => {
    const f = manualBookEntry(depsFor(a.env, ctx), a.env.outlet, a.input);
    return { muts: billMutations(f), result: f };
  });
}

/** creditnote.issue: a credit note citing a numbered bill (the original is read from the local store when not given). One number. */
export function creditNoteSpec(a: Common<CreditNoteResult> & { env: DocumentEnv; billId: string; request: Omit<CreditRequest, "lines"> & { lines?: CreditRequest["lines"] }; original?: OriginalBill }): RecordSpec {
  return spec("creditnote.issue", a, (ctx) => {
    const original = a.original ?? loadOriginalBill(ctx, a.billId);
    const lines = a.request.lines ?? original.lines.map((l) => ({ bill_line_id: l.id, qty_milli: l.qty_milli - (a.request.previousCredited?.[l.id] ?? 0) })).filter((l) => l.qty_milli > 0);
    const c = issueCreditNote(depsFor(a.env, ctx), a.env.outlet, original, { ...a.request, lines });
    return { muts: creditNoteMutations(c), result: c };
  });
}

/**
 * bill.rebill: a full credit note plus one or more replacement bills in ONE op, so no node sees half of it. It takes
 * several numbers in one transaction: the credit note first, then each replacement bill.
 */
export function rebillSpec(
  a: Common<RebillResult> & {
    env: DocumentEnv;
    billId: string;
    replacements: readonly Replacement[];
    reasonCodeId?: string;
    refundTender?: RefundTender;
    previousCredited?: Readonly<Record<string, number>>;
    original?: OriginalBill;
  },
): RecordSpec {
  return spec("bill.rebill", a, (ctx) => {
    const original = a.original ?? loadOriginalBill(ctx, a.billId);
    const r = rebill(depsFor(a.env, ctx), a.env.outlet, original, a.replacements, {
      ...(a.reasonCodeId ? { reasonCodeId: a.reasonCodeId } : {}),
      ...(a.refundTender ? { refundTender: a.refundTender } : {}),
      ...(a.previousCredited ? { previousCredited: a.previousCredited } : {}),
    });
    return { muts: rebillMutations(r), result: r };
  });
}

/** bill.present: record the unnumbered pre-bill the guest was shown. Takes no number. */
export function presentSpec(a: Common<ReturnType<typeof presentCheck>> & { env: DocumentEnv; header: CheckHeader & { id: string }; lines: readonly BillableLine[]; options: Omit<PresentOptions, "nowMs" | "newId"> }): RecordSpec {
  return spec("bill.present", a, (ctx) => {
    const p = presentCheck(a.env.outlet, a.header, a.lines, { ...a.options, nowMs: ctx.now, newId: () => ctx.newId() });
    const { id, ...rest } = p.row;
    return { muts: [{ e: "check_present", id, k: "insert", f: rest }], result: p };
  });
}

/** payment.record: how a guest paid a numbered bill (a further share, or a bill issued before paying). Takes no number. */
export function paymentSpec(a: Common<PaymentRow[]> & { billId: string; businessDate: string; payments: readonly PaymentInput[] }): RecordSpec {
  return spec("payment.record", a, (ctx) => {
    const rows: PaymentRow[] = a.payments.map((p) => ({ id: ctx.newId(), bill_id: a.billId, target_kind: "bill", business_date: a.businessDate, ...p }));
    const muts: Mutation[] = rows.map(({ id, ...f }) => ({ e: "payment", id, k: "insert", f }));
    return { muts, result: rows };
  });
}

const stored = (r: Row): Record<string, unknown> => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("_") && k !== "tenant_id" && k !== "deleted"));

/**
 * Reads a numbered bill back from the local store as the documents code wants it (self-contained: the bill, its
 * lines and its tax lines). Tax lines are stored with `bill_id`; the documents code names it `owner_id`.
 */
export function loadOriginalBill(ctx: Pick<BuildCtx, "get" | "list">, billId: string): OriginalBill {
  const bill = ctx.get("bill", billId);
  if (!bill) throw new DocumentError("bill_not_found", billId);
  const lines = ctx
    .list("bill_line")
    .filter((l) => l.bill_id === billId)
    .map((l) => stored(l) as unknown as BillLineRow)
    .sort((a, b) => a.line_no - b.line_no);
  const taxLines = ctx
    .list("bill_tax_line")
    .filter((t) => t.bill_id === billId)
    .map((t) => {
      const { bill_id, ...r } = stored(t);
      return { ...r, owner_id: bill_id } as unknown as TaxLineRow;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { bill: stored(bill) as unknown as BillRow, lines, taxLines };
}
