/**
 * `@hostry/client-core/testing`: the sync simulator for app tests (a LAN hub and cloud as FakeNode, deterministic
 * clock and random, device worlds, batch shipping and scenarios). Not for production code; the main entry does not
 * import it.
 */
export * from "./sync/testkit/fake-node";
export * from "./sync/testkit/harness";
export * from "./sync/testkit/ship";
export * from "./sync/testkit/scenario";
