import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical";
import { InMemoryStore } from "../store";
import { KeyRing, SoftwareSigner, attestationMessage, endorsementMessage, genesisHash, makeSeal, sealMessage, sha256Hex, verifySeal } from "./crypto";
import { SyncEngine } from "./engine";
import { packHlc } from "./hlc";
import { demoRegistry } from "./schema";
import { makeWorld, OUTLET } from "./testkit/harness";
import vectors from "./testkit/vectors-v1.json";
import type { Attestation, Endorsement, Seal, WireItem } from "./types";

/** svc-sync contract/vectors/v1.json (copied; Go checks the same file). Compared as data, never by key order. */
describe("shared conformance vectors v1", () => {
  it("canonical JSON", () => {
    for (const v of vectors.canonical) expect(canonicalize(JSON.parse(v.In))).toBe(v.Out);
  });
  it("body hash, genesis, seal message, hlc", async () => {
    for (const v of vectors.hash) expect(await sha256Hex(v.Body)).toBe(v.H);
    for (const v of vectors.genesis) expect(await genesisHash(v.Origin, v.Stream)).toBe(v.H);
    for (const v of vectors.seal_message) expect(sealMessage(v.Origin, v.Stream, v.Seq, v.H)).toBe(v.Message);
    for (const v of vectors.hlc) expect(packHlc(v.Ms, v.Counter)).toBe(v.Hex);
  });
});

describe("a cloud op-signing key is not a seal key for device origins (ADR-0002 A2.1)", () => {
  it("accepts a device seal only under that device's own key; the cloud key seals cloud origins only", async () => {
    const dev = await SoftwareSigner.generate("k1");
    const gw = await SoftwareSigner.generate("gk1");
    const ring = new KeyRing();
    await ring.add("dev-a", "k1", dev.publicB64);
    await ring.addCloudKey("gk1", gw.publicB64);
    expect(await verifySeal(ring, await makeSeal(dev, "dev-a", "outlet:o1", 3, "ab"))).toBe(true);
    expect(await verifySeal(ring, await makeSeal(gw, "dev-a", "outlet:o1", 3, "ab"))).toBe(false);
    expect(await verifySeal(ring, await makeSeal(gw, "cloud-e1", "outlet:o1", 1, "ab"))).toBe(true);
  });
});

/** KL12, KL13: endorsed tail of a key-lost origin. */
describe("released unsealed tail under endorsement (ADR-0002 A2.1, KL12-KL13)", () => {
  async function scene() {
    const w = await makeWorld();
    const old = await w.addDevice("devOld", { withHub: false, grants: [{ code: "A07", docType: "tax_invoice", state: "active" }] });
    for (let i = 0; i < 5; i++) {
      await old.engine.record({ intent: "bill.finalize", build: (c) => [{ e: "bill", id: `b${i}`, k: "insert", f: { number: c.number("tax_invoice") } }] });
      if (i === 2) await old.engine.sealOwn(OUTLET);
    }
    old.signer.lose();
    const fresh = await w.addDevice("devNew", { withHub: false, store: old.store });
    const [up] = await fresh.engine.recoveryUpload("devOld", { [OUTLET]: { devOld: 0 } }, "rec-1");
    const identity = await SoftwareSigner.generate("id");
    const cred = { device_id: "devNew", tenant_id: "t1", outlet_id: "o1", brand_id: "b1", kind: "pos" as const, kid: fresh.signer.kid, pub: fresh.signer.publicB64, recovers: "devOld", not_after: 9e9 };
    const envelope = { cred, sig: await identity.sign(`hostry-cred-v1\n${canonicalize(cred)}`) };
    const endorse = async (it: WireItem, rec = "rec-1", key: SoftwareSigner = w.cloudSigner): Promise<Endorsement> => {
      const e = { origin: it.origin, stream: it.stream, seq: it.seq, h: it.h, rec };
      return { ...e, kid: key.kid, sig: await key.sign(endorsementMessage(e)) };
    };
    const tail = up!.items.filter((i) => i.seq > 3);
    const endorsements = await Promise.all(tail.map((i) => endorse(i)));
    const receiver = async (withCred = true) => {
      const ring = new KeyRing(identity.publicB64);
      await ring.add("devOld", old.signer.kid, old.signer.publicB64);
      await ring.addCloudKey(w.cloudSigner.kid, w.cloudSigner.publicB64);
      if (withCred) await ring.ingest([envelope]);
      const rxSigner = await SoftwareSigner.generate("rxk");
      const engine = await SyncEngine.open({ store: new InMemoryStore("t1"), schemas: demoRegistry(), deviceId: "rx", outletStream: OUTLET, signer: rxSigner, verifier: ring, packVersion: 1 });
      return { ring, engine };
    };
    return { w, fresh, up: up!, endorse, endorsements, receiver, attestation: up!.attestation as Attestation, seals: up!.seals as Seal[] };
  }

  it("KL12: takes the whole tail under endorsement, credential and attestation, and marks it unsealed", async () => {
    const s = await scene();
    const { engine } = await s.receiver();
    const r = await engine.applyRemote(OUTLET, s.up.items, s.seals, { endorsements: s.endorsements, attestations: [s.attestation] });
    expect(r).toMatchObject({ applied: 5, rejected: [] });
    expect((await engine.unsealedOps()).map((o) => o.seq)).toEqual([4, 5]);
  });

  it("KL13: refuses the tail when any one of the three parts is wrong; the sealed part still applies", async () => {
    const s = await scene();
    const accept = async (r: Awaited<ReturnType<typeof s.receiver>>, e: Endorsement[], a: Attestation[]) => {
      const res = await r.engine.applyRemote(OUTLET, s.up.items, s.seals, { endorsements: e, attestations: a });
      expect(await r.engine.unsealedOps()).toEqual([]);
      return res.applied;
    };
    // (a) no credential carries `recovers`
    expect(await accept(await s.receiver(false), s.endorsements, [s.attestation])).toBe(3);
    // (b) attested seq below the endorsed op: attestation signed by the adopting device at seq 4, endorsement for 5
    const low = { ...s.attestation, seq: 4, h: s.up.items[3]!.h };
    const lowSigned: Attestation = { ...low, sig: await s.fresh.signer.sign(attestationMessage(low)) };
    const rb = await s.receiver();
    expect((await rb.engine.applyRemote(OUTLET, s.up.items, s.seals, { endorsements: s.endorsements, attestations: [lowSigned] })).applied).toBe(4); // op 5 is above the attested seq
    expect((await rb.engine.unsealedOps()).map((o) => o.seq)).toEqual([4]);
    // (c) endorsement carries a different rec
    const wrongRec = await Promise.all(s.up.items.filter((i) => i.seq > 3).map((i) => s.endorse(i, "rec-2")));
    expect(await accept(await s.receiver(), wrongRec, [s.attestation])).toBe(3);
    // (d) a seal-tagged signature by the op-signing key for a device origin
    const forged = await makeSeal(s.w.cloudSigner, "devOld", OUTLET, 5, s.up.items[4]!.h);
    const r = await s.receiver();
    expect((await r.engine.applyRemote(OUTLET, s.up.items, [forged], {})).applied).toBe(0);
    // (e) endorsement under a revoked op-signing key
    const revoked = await s.receiver();
    revoked.ring.revokeCloudKey(s.w.cloudSigner.kid);
    expect(await accept(revoked, s.endorsements, [s.attestation])).toBe(3);
  });
});
