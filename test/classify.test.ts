/**
 * The classification spine: every message lands in a box, and a list only
 * ever shows the box it asked for.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { KEEP_ORDER } from "../src/index";
import { LIMIT_RANGES } from "../src/limits";
import { buildMail, call, deliver, env, freshDatabase, json, signIn } from "./helpers";

let cookie: string;
beforeEach(async () => {
  await freshDatabase();
  cookie = await signIn();
});

/** Puts a message straight into a box, the way a filter later will. */
async function place(box: string, address = "held@mail.example.test", id = crypto.randomUUID()) {
  await env.DB.prepare(
    "INSERT INTO messages (id, address, from_address, subject, snippet, received_at, read, box, box_reason) VALUES (?1,?2,?3,?4,?5,?6,0,?7,?8)"
  )
    .bind(id, address, "stranger@example.org", "Held", "x", Date.now(), box, "a test put it here")
    .run();
  return id;
}

describe("boxes", () => {
  it("delivers ordinary mail to the inbox", async () => {
    expect(await deliver(buildMail({ to: "a@mail.example.test" }), "a@mail.example.test")).toEqual([]);
    const row = await env.DB.prepare("SELECT box, box_reason FROM messages").first<{ box: string; box_reason: string | null }>();
    expect(row?.box).toBe("inbox");
    expect(row?.box_reason).toBeNull();
  });

  it("keeps mail in other boxes out of the default list", async () => {
    await deliver(buildMail({ to: "a@mail.example.test", subject: "Ordinary" }), "a@mail.example.test");
    await place("screener");
    await place("junk");

    const inbox = await json(await call("/api/messages", { cookie }));
    expect(inbox.messages.map((m: any) => m.subject)).toEqual(["Ordinary"]);

    const screener = await json(await call("/api/messages?box=screener", { cookie }));
    expect(screener.messages).toHaveLength(1);
    expect(screener.messages[0].subject).toBe("Held");
  });

  it("refuses a box it does not have", async () => {
    const res = await call("/api/messages?box=nowhere", { cookie });
    expect(res.status).toBe(400);
  });

  it("counts only the inbox in the rail, and reports the rest separately", async () => {
    await deliver(buildMail({ to: "a@mail.example.test" }), "a@mail.example.test");
    await place("screener", "a@mail.example.test");
    await place("junk", "a@mail.example.test");

    const data = await json(await call("/api/addresses", { cookie }));
    const entry = data.addresses.find((a: any) => a.address === "a@mail.example.test");
    expect(entry.count).toBe(1);
    expect(data.boxes).toEqual({ screener: { count: 1, unread: 1 }, junk: { count: 1, unread: 1 } });
  });

  it("lists an address that only has held mail without counting it", async () => {
    await place("screener", "only-held@mail.example.test");
    const data = await json(await call("/api/addresses", { cookie }));
    const held = await json(await call("/api/messages?box=screener", { cookie }));
    expect(held.messages).toHaveLength(1);
    // The rail is the inbox's rail; an address with nothing in the inbox is
    // not a row there, and the Screener's own count is what says it exists.
    expect(data.addresses.some((a: any) => a.address === "only-held@mail.example.test")).toBe(false);
  });

  it("marks all read without clearing the other boxes", async () => {
    await deliver(buildMail({ to: "a@mail.example.test" }), "a@mail.example.test");
    await place("screener", "a@mail.example.test");

    expect((await call("/api/read-all", { method: "POST", cookie })).status).toBe(200);
    const data = await json(await call("/api/addresses", { cookie }));
    expect(data.boxes.screener.unread).toBe(1);
    const inbox = await json(await call("/api/messages", { cookie }));
    expect(inbox.messages.every((m: any) => m.read)).toBe(true);
  });

  it("says which box a message is in when it is opened", async () => {
    const id = await place("screener");
    const msg = await json(await call(`/api/messages/${id}`, { cookie }));
    expect(msg.box).toBe("screener");
    expect(msg.boxReason).toBe("a test put it here");
  });
});

describe("boxes and the caps", () => {
  const countIn = async (box: string, address?: string) =>
    (await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE box = ?1${address ? " AND address = ?2" : ""}`
    ).bind(...(address ? [box, address] : [box])).first<{ n: number }>())!.n;

  it("gives each box its own per-address quota", async () => {
    const address = "flood@mail.example.test";
    const cap = LIMIT_RANGES.perAddress.min;
    await call("/api/settings", { method: "PUT", cookie, json: { perAddress: cap } });
    for (let i = 0; i < cap; i++) await deliver(buildMail({ subject: `Real ${i}` }), address);
    // A guessing attack is exactly what fills the Screener, and it must not be
    // able to push an address's real mail out of the inbox on the way.
    for (let i = 0; i < cap + 5; i++) await place("screener", address);
    await deliver(buildMail({ subject: "Newest" }), address);

    expect(await countIn("inbox", address)).toBe(cap);
    expect(await countIn("screener", address)).toBe(cap + 5);
    const inbox = await json(await call(`/api/messages?address=${address}`, { cookie }));
    expect(inbox.messages[0].subject).toBe("Newest");
    // The oldest real message is the one that went, not all of them.
    expect(inbox.messages.some((m: any) => m.subject === "Real 0")).toBe(false);
    expect(inbox.messages.some((m: any) => m.subject === "Real 1")).toBe(true);
  }, 20_000);

  it("throws junk away before anything else when the global cap bites", async () => {
    // Asserted against the ordering the cron uses rather than by seeding past
    // the cap's 100-message floor, which costs half a minute to say the same
    // thing. KEEP_ORDER is the whole of what decides this.
    await place("junk", "j@mail.example.test", "junk-newest");
    await new Promise((r) => setTimeout(r, 2));
    await place("inbox", "keep@mail.example.test", "inbox-older");
    await env.DB.prepare("UPDATE messages SET received_at = received_at - 60000 WHERE id = 'inbox-older'").run();
    await place("inbox", "starred@mail.example.test", "starred-oldest");
    await env.DB.prepare("UPDATE messages SET starred = 1, received_at = received_at - 120000 WHERE id = 'starred-oldest'").run();

    const { results } = await env.DB.prepare(`SELECT id FROM messages ORDER BY ${KEEP_ORDER}`).all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["starred-oldest", "inbox-older", "junk-newest"]);
  });
});
