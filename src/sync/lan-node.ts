import { Agent, request } from "node:https";
import { X509Certificate } from "node:crypto";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { LanError, spkiHash, type LanChannel, type LanChannelResponse } from "./lan";

/**
 * Node implementation of the LAN channel (ADR-0002 A3.1 item 8): `node:tls`, TLS 1.3 only, any certificate accepted, `spki`
 * taken from the certificate the connection really got. A connection to a certificate other than the pinned `spki` is closed
 * before the request is written, so the session token never reaches a relay. Used by the soak, the simulator and tests; the
 * Tauri `hubLink` is the production implementation. Import from `@hostry/client-core/node`, never from the browser bundle.
 */
export type NodeLanChannelConfig = {
  /** `https://192.168.1.20:8443` */
  baseUrl: string;
  timeoutMs?: number;
};

export function nodeLanChannel(cfg: NodeLanChannelConfig): LanChannel {
  const base = new URL(cfg.baseUrl);
  const spkiOf = new WeakMap<object, string>();
  // One keep-alive pool per pinned value (and one for the unpinned hello): every socket in a pool was checked against it.
  const pools = new Map<string, Agent>();

  const pool = (pin: string | undefined): Agent => {
    const key = pin ?? "";
    let a = pools.get(key);
    if (a) return a;
    a = new Agent({ keepAlive: true, maxSockets: 4 });
    // `createConnection` with a callback lets us hold the request until the certificate has been judged.
    (a as unknown as { createConnection: (o: object, cb: (e: Error | null, s?: TLSSocket) => void) => void }).createConnection = (_o, cb) => {
      const s = tlsConnect({
        host: base.hostname,
        port: Number(base.port || 443),
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        rejectUnauthorized: false, // carries no trust: the peer is proven by helloLan
        servername: /^[\d.]+$|:/.test(base.hostname) ? "" : base.hostname,
      });
      s.once("error", (e) => cb(e));
      s.once("secureConnect", () => {
        void (async () => {
          try {
            const cert = s.getPeerCertificate(true) as { raw?: Buffer };
            if (!cert.raw) throw new Error("no peer certificate");
            const der = new Uint8Array(new X509Certificate(cert.raw).publicKey.export({ type: "spki", format: "der" }));
            const spki = await spkiHash(der);
            if (pin !== undefined && spki !== pin) throw new LanError("spki_changed", "hub certificate differs from the verified one");
            spkiOf.set(s, spki);
            s.removeAllListeners("error");
            cb(null, s);
          } catch (e) {
            s.destroy();
            cb(e instanceof Error ? e : new Error(String(e)));
          }
        })();
      });
    };
    pools.set(key, a);
    return a;
  };

  return {
    peerCertReadable: true,
    post(path, body, headers, pinSpki) {
      return new Promise<LanChannelResponse>((resolve, reject) => {
        const req = request(
          {
            agent: pool(pinSpki),
            host: base.hostname,
            port: Number(base.port || 443),
            path,
            method: "POST",
            headers: { ...headers, "content-length": Buffer.byteLength(body) },
            timeout: cfg.timeoutMs ?? 10_000,
          },
          (res) => {
            const spki = res.socket ? spkiOf.get(res.socket) : undefined; // read now: the socket detaches at the end of the response
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), ...(spki ? { spki } : {}) });
            });
            res.on("error", reject);
          },
        );
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        req.end(body);
      });
    },
  };
}
