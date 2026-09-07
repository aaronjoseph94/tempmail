/** Instant delivery: the WebSocket route and the Durable Object it hands sockets to. */
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hubStub, type InboxHub } from "../src/live";
import { buildMail, call, deliver, env, freshDatabase, json, signIn } from "./helpers";

let cookie: string;
beforeEach(async () => {
  await freshDatabase();
  cookie = await signIn();
});

describe("GET /api/live", () => {
  it("is behind the session gate", async () => {
    expect((await call("/api/live", { headers: { upgrade: "websocket", origin: "https://mail.example.test" } })).status).toBe(401);
  });

  it("wants a WebSocket upgrade", async () => {
    expect((await call("/api/live", { cookie })).status).toBe(426);
  });

  it("refuses a handshake from another origin", async () => {
    const res = await call("/api/live", { cookie, headers: { upgrade: "websocket", origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("the hub", () => {
  it("hears about mail from Email Routing", async () => {
    await deliver(buildMail({ subject: "Your code is 482913" }), "live@mail.example.test");
    const { messages } = await json(await call("/api/messages", { cookie }));
    await runInDurableObject(hubStub(env), (hub: InboxHub) => {
      expect(hub.last).toMatchObject({ type: "new", address: "live@mail.example.test", id: messages[0].id, code: "482913" });
    });
  });

  it("hears about mail from the dev ingest route too", async () => {
    const res = await call("/api/dev/ingest?to=dev@mail.example.test&from=a@example.org", {
      method: "POST", body: buildMail({ subject: "Hi" }), headers: { "x-ingest-key": "k" }, env: { INGEST_KEY: "k" },
    });
    expect(res.status).toBe(200);
    await runInDurableObject(hubStub(env), (hub: InboxHub) => {
      expect(hub.last).toMatchObject({ type: "new", address: "dev@mail.example.test" });
    });
  });

  it("does not hear about bounced mail", async () => {
    await runInDurableObject(hubStub(env), (hub: InboxHub) => { hub.last = null; });
    await call("/api/addresses/dead@mail.example.test", { cookie, method: "PUT", json: { mode: "blocked" } });
    expect(await deliver(buildMail(), "dead@mail.example.test")).toEqual(["No such mailbox"]);
    await runInDurableObject(hubStub(env), (hub: InboxHub) => { expect(hub.last).toBeNull(); });
  });
});
