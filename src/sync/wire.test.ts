import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical";
import { KeyRing, SoftwareSigner, genesisHash, makeSeal, sealMessage, sha256Hex, verifySeal } from "./crypto";
import { HlcClock, compareStamp, packHlc, unpackHlc, MAX_FUTURE_MS } from "./hlc";

/**
 * Golden vectors produced by svc-sync `syncproto` (Go) on 2026-11-24: the TypeScript encoder must give
 * the same bytes and the same hashes, or a seal made on one side fails on the other (ADR-0002 S15
 * "engine conformance"; the shared vectors in api-specs/sync/conformance/ replace these when they land).
 */
const GO = {
  genesis: "e8e85557194983a052b36b021c32c65cb07e1594342279959a1ec61eaca68e48",
  sealMessage: "hostry-seal-v1\ndev-1\noutlet:o1\n7\nab12",
  bodyHash: "370a7a50cad0feae09928abfcd06c8f1ec22b649673fd94b033ae505b43404c3",
  body: '{"actor":"m1","at":"2026-11-24T13:05:11.120Z","clk":"sync","doc":{"number":"A07/2627/000123","type":"tax_invoice"},"hlc":"0193a5f2c7b40003","intent":"bill.finalize","intent_v":1,"muts":[{"e":"bill","f":{"name":"Café \\"x\\"\\n","number":"A07/2627/000123","total_paise":84000},"id":"b1","k":"insert"},{"e":"menu_item","f":{"price_paise":18000},"id":"m1","k":"set","prev":{"price_paise":"0193a5e0aa100000"}}],"origin":"dev-1","pack_v":"p1","ph":"e8e85557194983a052b36b021c32c65cb07e1594342279959a1ec61eaca68e48","seq":1,"sid":"s1","stream":"outlet:o1","tenant_id":"t1","v":1}',
  canon: '{"A":null,"a":"é\\u0001","b":[3,1,{"a":0,"z":1}],"€":true}',
};

describe("wire conformance with the Go encoder", () => {
  it("genesis hash and seal message match", async () => {
    expect(await genesisHash("dev-1", "outlet:o1")).toBe(GO.genesis);
    expect(sealMessage("dev-1", "outlet:o1", 7, "ab12")).toBe(GO.sealMessage);
  });

  it("canonical body text and its hash match", async () => {
    const op = {
      v: 1,
      origin: "dev-1",
      stream: "outlet:o1",
      seq: 1,
      ph: GO.genesis,
      hlc: "0193a5f2c7b40003",
      clk: "sync",
      tenant_id: "t1",
      actor: "m1",
      sid: "s1",
      pack_v: "p1",
      intent: "bill.finalize",
      intent_v: 1,
      at: "2026-11-24T13:05:11.120Z",
      doc: { type: "tax_invoice", number: "A07/2627/000123" },
      muts: [
        { e: "bill", id: "b1", k: "insert", f: { number: "A07/2627/000123", total_paise: 84000, name: 'Café "x"\n' } },
        { e: "menu_item", id: "m1", k: "set", f: { price_paise: 18000 }, prev: { price_paise: "0193a5e0aa100000" } },
      ],
    };
    const text = canonicalize(op);
    expect(text).toBe(GO.body);
    expect(await sha256Hex(text)).toBe(GO.bodyHash);
  });

  it("canonicalises key order, escapes and negative zero as the Go side does; refuses non-integers", () => {
    expect(canonicalize(JSON.parse('{"b":[3,1,{"z":1,"a":-0}],"a":"\\u00e9\\u0001","\\u20ac":true,"A":null}'))).toBe(GO.canon);
    expect(() => canonicalize({ x: 1.5 })).toThrow(/safe integer/);
    expect(() => canonicalize({ x: 2 ** 53 })).toThrow(/safe integer/);
  });
});

describe("seals", () => {
  it("verify with the right key and fail on a changed hash, a wrong origin or another key", async () => {
    const dev = await SoftwareSigner.generate("k1");
    const other = await SoftwareSigner.generate("k2");
    const ring = new KeyRing();
    await ring.add("dev-1", "k1", dev.publicB64);
    await ring.add("dev-2", "k1", other.publicB64);
    const seal = await makeSeal(dev, "dev-1", "outlet:o1", 5, "aa");
    expect(await verifySeal(ring, seal)).toBe(true);
    expect(await verifySeal(ring, { ...seal, h: "bb" })).toBe(false);
    expect(await verifySeal(ring, { ...seal, seq: 6 })).toBe(false);
    expect(await verifySeal(ring, { ...seal, origin: "dev-2" })).toBe(false); // dev-2 holds a different key
    expect(await verifySeal(new KeyRing(), seal)).toBe(false); // unknown origin
  });

  it("accepts credentials only when identity signed them", async () => {
    const identity = await SoftwareSigner.generate("id");
    const dev = await SoftwareSigner.generate("k1");
    const ring = new KeyRing(identity.publicB64);
    const cred = { device_id: "dev-9", tenant_id: "t1", outlet_id: "o1", kind: "pos", kid: "k1", pub: dev.publicB64, not_after: 2000000000 };
    const good = { cred, sig: await identity.sign(`hostry-cred-v1\n${canonicalize(cred)}`) };
    const forged = { cred: { ...cred, device_id: "dev-evil" }, sig: good.sig };
    expect(await ring.ingest([forged])).toBe(0);
    expect(await ring.ingest([good])).toBe(1);
    expect(await verifySeal(ring, await makeSeal(dev, "dev-9", "outlet:o1", 1, "h"))).toBe(true);
  });
});

describe("hybrid logical clock", () => {
  it("is strictly increasing even when the wall clock stalls or steps back", () => {
    let t = 1_000_000;
    const c = new HlcClock(() => t);
    const a = c.next();
    const b = c.next();
    t -= 5_000;
    const d = c.next();
    expect(a < b && b < d).toBe(true);
    expect(unpackHlc(d).ms).toBe(1_000_000);
  });

  it("sorts after an observed remote stamp, and ignores one stamped more than 10 minutes ahead", () => {
    const c = new HlcClock(() => 1_000_000);
    c.observe(packHlc(1_005_000, 7));
    expect(c.next() > packHlc(1_005_000, 7)).toBe(true);
    const d = new HlcClock(() => 1_000_000);
    d.observe(packHlc(1_000_000 + MAX_FUTURE_MS + 1, 0)); // a runaway or hostile stamp
    expect(unpackHlc(d.next()).ms).toBe(1_000_000);
  });

  it("applies the upstream offset, rolls the 16-bit counter into the next millisecond, and breaks ties on origin", () => {
    const c = new HlcClock(() => 1_000, 500);
    expect(unpackHlc(c.next()).ms).toBe(1_500);
    const full = new HlcClock(() => 10, 0, packHlc(10, 0xffff));
    expect(unpackHlc(full.next())).toEqual({ ms: 11, counter: 0 });
    expect(compareStamp("0000000000000001", "a", "0000000000000001", "b")).toBeLessThan(0);
    expect(() => unpackHlc("xyz")).toThrow();
  });
});
