import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { WebSocketServer } from "ws";
import { createNostrEvent, signNostrEvent, publishNostrEvent } from "../event/event-tools.js";
import { KINDS } from "../utils/constants.js";

// Regression test for the real-world Buzz relay behavior: the relay replies
// to a pre-AUTH EVENT with an immediate `["OK", id, false, "auth-required: ..."]`
// (rather than staying silent until the AUTH round-trip completes), then
// separately sends an `["AUTH", challenge]` frame and accepts the resend.
// A client that treats that first OK as final never sees the real success —
// this is exactly the false-negative Vector hit against the live Buzz relay.
describe("publishNostrEvent vs a relay that rejects the pre-AUTH send first", () => {
  const privateKey = "0000000000000000000000000000000000000000000000000000000000000002";
  let wss: WebSocketServer;
  let relayUrl: string;

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const addr = wss.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    relayUrl = `ws://127.0.0.1:${port}`;

    wss.on("connection", (ws) => {
      let authed = false;
      const challenge = "test-challenge";
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg[0] === "EVENT") {
          const event = msg[1];
          if (!authed) {
            // Mimic Buzz: reject the premature send immediately...
            ws.send(JSON.stringify(["OK", event.id, false, "auth-required: not authenticated"]));
            // ...then issue the AUTH challenge.
            ws.send(JSON.stringify(["AUTH", challenge]));
            return;
          }
          // Post-AUTH resend succeeds for real.
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
        } else if (msg[0] === "AUTH") {
          const authEvent = msg[1];
          if (authEvent?.tags?.some((t: string[]) => t[0] === "challenge" && t[1] === challenge)) {
            authed = true;
          }
        }
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  test("publishNostrEvent reports success once the post-AUTH resend is actually accepted", async () => {
    const created = await createNostrEvent({
      kind: KINDS.TEXT,
      content: `premature-auth-required-${Date.now()}`,
      tags: [],
      privateKey,
    });
    expect(created.success).toBe(true);

    const signed = await signNostrEvent({ privateKey, event: created.event as any });
    expect(signed.success).toBe(true);

    const result = await publishNostrEvent({
      signedEvent: signed.signedEvent as any,
      relays: [relayUrl],
      authPrivateKey: privateKey,
    });

    expect(result.success).toBe(true);
    expect(result.acceptedBy).toBe(1);
  });
});
