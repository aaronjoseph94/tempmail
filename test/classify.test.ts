/**
 * The classification spine: every message lands in a box, and a list only
 * ever shows the box it asked for.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { KEEP_ORDER, LIMIT_RANGES } from "../src/limits";
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

describe("the Screener", () => {
  const on = () => call("/api/settings", { method: "PUT", cookie, json: { screener: true } });
  const boxOf = async (subject: string) =>
    await env.DB.prepare("SELECT box, deleted_at FROM messages WHERE subject = ?1").bind(subject)
      .first<{ box: string; deleted_at: number | null }>();
  const make = (address: string, body: Record<string, unknown> = {}) =>
    call(`/api/addresses/${encodeURIComponent(address)}`, { cookie, method: "PUT", json: { mode: "permanent", ...body } });

  it("is off until it is switched on", async () => {
    expect((await json(await call("/api/config", { cookie }))).screener).toBe(false);
    await deliver(buildMail({ subject: "Stranger" }), "guessed@mail.example.test");
    expect((await boxOf("Stranger"))?.box).toBe("inbox");
  });

  it("holds the first message from a sender nobody has vouched for", async () => {
    await on();
    await deliver(buildMail({ subject: "Held" }), "guessed@mail.example.test");
    const row = await boxOf("Held");
    expect(row?.box).toBe("screener");
    // And it stays out of the inbox list and the unread count.
    const inbox = await json(await call("/api/messages", { cookie }));
    expect(inbox.messages).toHaveLength(0);
    const rail = await json(await call("/api/addresses", { cookie }));
    expect(rail.boxes.screener.count).toBe(1);
  });

  it("lets through the service an address was made for", async () => {
    await on();
    await make("shop-a1@mail.example.test", { ownerDomain: "shop.example" });
    await deliver(buildMail({ from: "hello@mail.shop.example", subject: "Your order" }), "shop-a1@mail.example.test");
    expect((await boxOf("Your order"))?.box).toBe("inbox");
  });

  it("lets through the first message to a burner the owner just made", async () => {
    await on();
    await make("fresh-b2@mail.example.test");
    await deliver(buildMail({ from: "noreply@unknown.example", subject: "Welcome" }), "fresh-b2@mail.example.test");
    expect((await boxOf("Welcome"))?.box).toBe("inbox");
    // The second stranger, once mail has arrived, is a stranger again.
    await deliver(buildMail({ from: "someone@elsewhere.example", subject: "Later" }), "fresh-b2@mail.example.test");
    expect((await boxOf("Later"))?.box).toBe("screener");
  });

  it("never swallows a code sent to an address the owner made", async () => {
    await on();
    await make("codes-c3@mail.example.test");
    await deliver(buildMail({ subject: "Hello" }), "codes-c3@mail.example.test");   // uses up the fresh-burner pass
    await deliver(buildMail({ from: "auth@other.example", subject: "Sign in", text: "Your code is 448213" }), "codes-c3@mail.example.test");
    expect((await boxOf("Sign in"))?.box).toBe("inbox");
  });

  it("but a code to a guessed address is still held", async () => {
    await on();
    // Otherwise "your code is 123456" in a spam template is a way past the
    // Screener for every address anyone cares to guess.
    await deliver(buildMail({ from: "spam@nowhere.example", subject: "Code", text: "Your code is 991122" }), "guessed-d4@mail.example.test");
    expect((await boxOf("Code"))?.box).toBe("screener");
  });

  it("approves a sender, moves what it was holding, and lets the next one through", async () => {
    await on();
    await deliver(buildMail({ from: "news@paper.example", subject: "One" }), "reader@mail.example.test");
    await deliver(buildMail({ from: "news@paper.example", subject: "Two" }), "reader@mail.example.test");

    const waiting = await json(await call("/api/senders", { cookie }));
    expect(waiting.senders).toHaveLength(1);
    expect(waiting.senders[0]).toMatchObject({ address: "news@paper.example", held: 2 });

    const res = await json(await call("/api/senders/news@paper.example", { cookie, json: { verdict: "allowed" } }));
    expect(res.ids).toHaveLength(2);
    expect((await boxOf("One"))?.box).toBe("inbox");
    await deliver(buildMail({ from: "news@paper.example", subject: "Three" }), "reader@mail.example.test");
    expect((await boxOf("Three"))?.box).toBe("inbox");
  });

  it("bins a sender into the trash, where the undo window applies", async () => {
    await on();
    await deliver(buildMail({ from: "spam@bad.example", subject: "Junk one" }), "reader@mail.example.test");
    const res = await json(await call("/api/senders/spam@bad.example", { cookie, json: { verdict: "binned" } }));
    const binned = await boxOf("Junk one");
    expect(binned?.deleted_at).toBeGreaterThan(0);
    // Later mail from a binned sender goes straight to the trash too.
    await deliver(buildMail({ from: "spam@bad.example", subject: "Junk two" }), "reader@mail.example.test");
    expect((await boxOf("Junk two"))?.deleted_at).toBeGreaterThan(0);

    // Undo puts back exactly what the decision moved.
    await call("/api/senders/spam@bad.example", { cookie, json: { verdict: "unknown", ids: res.ids } });
    expect((await boxOf("Junk one"))).toMatchObject({ box: "screener", deleted_at: null });
    expect((await boxOf("Junk two"))?.deleted_at).toBeGreaterThan(0);   // not this one
  });

  it("vouches for everyone already in the inbox when it is switched on", async () => {
    await deliver(buildMail({ from: "known@friend.example", subject: "Before" }), "reader@mail.example.test");
    await on();
    await deliver(buildMail({ from: "known@friend.example", subject: "After" }), "reader@mail.example.test");
    expect((await boxOf("After"))?.box).toBe("inbox");
  });

  it("refuses a verdict it does not have", async () => {
    expect((await call("/api/senders/x@y.example", { cookie, json: { verdict: "banished" } })).status).toBe(400);
  });
});

describe("the Screener and address ownership", () => {
  it("does not let a held sender become the address's owner", async () => {
    await call("/api/settings", { method: "PUT", cookie, json: { screener: true } });
    // Guessing an address must not cost an attacker one held message and then
    // nothing: without this, recordArrival would make their domain the
    // address's owner and every later message would be exempt.
    for (const subject of ["First", "Second", "Third"]) {
      await deliver(buildMail({ from: "bot@guesser.example", subject }), "victim@mail.example.test");
    }
    const { results } = await env.DB.prepare("SELECT subject, box FROM messages ORDER BY received_at").all<{ subject: string; box: string }>();
    expect(results.map((r) => r.box)).toEqual(["screener", "screener", "screener"]);
    // Nor may it create the address: otherwise an afternoon of guessing puts
    // one rail row on screen per guess.
    const row = await env.DB.prepare("SELECT * FROM addresses WHERE address = 'victim@mail.example.test'").first();
    expect(row).toBeNull();
    const rail = await json(await call("/api/addresses", { cookie }));
    expect(rail.addresses).toHaveLength(0);
    expect(rail.boxes.screener.count).toBe(3);

    // Approving the sender puts the address back on the map.
    await call("/api/senders/bot@guesser.example", { cookie, json: { verdict: "allowed" } });
    const after = await json(await call("/api/addresses", { cookie }));
    expect(after.addresses.map((a: any) => a.address)).toEqual(["victim@mail.example.test"]);
  });

  it("still lets the first sender own the address when the Screener is off", async () => {
    await deliver(buildMail({ from: "hello@shop.example" }), "normal@mail.example.test");
    const row = await env.DB.prepare("SELECT owner_domain FROM addresses WHERE address = 'normal@mail.example.test'").first<{ owner_domain: string | null }>();
    expect(row?.owner_domain).toBe("shop.example");
  });
});

describe("the junk filter", () => {
  const trainWith = async (junk: boolean, ids: string[]) =>
    json(await call("/api/junk", { cookie, json: { ids, junk } }));
  const idsOf = async (like: string) =>
    (await env.DB.prepare("SELECT id FROM messages WHERE subject LIKE ?1").bind(like).all<{ id: string }>()).results.map((r) => r.id);

  /** Enough of both kinds for the filter to have an opinion at all. */
  async function teach(n = 6) {
    for (let i = 0; i < n; i++) {
      await deliver(buildMail({ from: `sender${i}@spam.example`, subject: `Junky ${i}`,
        text: "WINNER!! Claim your free prize money now, click here for your $$$ payout offer" }), `j${i}@mail.example.test`);
      await deliver(buildMail({ from: `friend${i}@good.example`, subject: `Real ${i}`,
        text: "Here are the notes from the meeting yesterday about the quarterly planning review" }), `h${i}@mail.example.test`);
    }
    await trainWith(true, await idsOf("Junky %"));
    await trainWith(false, await idsOf("Real %"));
  }

  it("says nothing until it has seen both kinds", async () => {
    const config = await json(await call("/api/config", { cookie }));
    expect(config.junk).toMatchObject({ junk: 0, ham: 0, ready: false });
    await deliver(buildMail({ subject: "Untrained", text: "WINNER!! free prize money $$$ click here" }), "a@mail.example.test");
    const row = await env.DB.prepare("SELECT box FROM messages WHERE subject = 'Untrained'").first<{ box: string }>();
    expect(row?.box).toBe("inbox");
  });

  it("moves a message and counts it once, however many times it is marked", async () => {
    await deliver(buildMail({ subject: "Nuisance", text: "buy now cheap offer" }), "a@mail.example.test");
    const [id] = await idsOf("Nuisance");
    const first = await trainWith(true, [id]);
    expect(first.junk.junk).toBe(1);
    const again = await trainWith(true, [id]);
    expect(again.junk.junk).toBe(1);
    const row = await env.DB.prepare("SELECT box, trained FROM messages WHERE id = ?1").bind(id).first<{ box: string; trained: string }>();
    expect(row).toMatchObject({ box: "junk", trained: "junk" });
  });

  it("takes the old evidence back when the verdict flips", async () => {
    await deliver(buildMail({ subject: "Wrongly", text: "quarterly planning notes" }), "a@mail.example.test");
    const [id] = await idsOf("Wrongly");
    await trainWith(true, [id]);
    const before = await env.DB.prepare("SELECT junk, ham FROM junk_tokens WHERE token = 'quarterly'").first<{ junk: number; ham: number }>();
    expect(before).toMatchObject({ junk: 1, ham: 0 });

    const after = await trainWith(false, [id]);
    expect(after.junk).toMatchObject({ junk: 0, ham: 1 });
    const token = await env.DB.prepare("SELECT junk, ham FROM junk_tokens WHERE token = 'quarterly'").first<{ junk: number; ham: number }>();
    expect(token).toMatchObject({ junk: 0, ham: 1 });
    const row = await env.DB.prepare("SELECT box FROM messages WHERE id = ?1").bind(id).first<{ box: string }>();
    expect(row?.box).toBe("inbox");
  });

  it("files new mail that looks like what it was taught", async () => {
    await teach();
    expect((await json(await call("/api/config", { cookie }))).junk.ready).toBe(true);
    await deliver(buildMail({ from: "new@spam.example", subject: "Fresh",
      text: "WINNER!! Claim your free prize money now, click here for your $$$ payout offer" }), "z@mail.example.test");
    const row = await env.DB.prepare("SELECT box, box_reason FROM messages WHERE subject = 'Fresh'").first<{ box: string; box_reason: string }>();
    expect(row?.box).toBe("junk");
    expect(row?.box_reason).toMatch(/junk/i);
  }, 30_000);

  it("leaves ordinary mail alone", async () => {
    await teach();
    await deliver(buildMail({ from: "colleague@good.example", subject: "Ordinary",
      text: "Here are the notes from the meeting yesterday about the quarterly planning review" }), "z@mail.example.test");
    const row = await env.DB.prepare("SELECT box FROM messages WHERE subject = 'Ordinary'").first<{ box: string }>();
    expect(row?.box).toBe("inbox");
  }, 30_000);

  it("never junks the service an address was made for", async () => {
    await teach();
    await call("/api/addresses/shop-x@mail.example.test", { cookie, method: "PUT", json: { mode: "permanent", ownerDomain: "spam.example" } });
    // Word for word the message it was taught to hate, but from the company
    // this address was handed to: the order confirmation must still arrive.
    await deliver(buildMail({ from: "orders@spam.example", subject: "Exempt",
      text: "WINNER!! Claim your free prize money now, click here for your $$$ payout offer" }), "shop-x@mail.example.test");
    const row = await env.DB.prepare("SELECT box FROM messages WHERE subject = 'Exempt'").first<{ box: string }>();
    expect(row?.box).toBe("inbox");
  }, 30_000);

  it("forgets everything on request without unfiling anything", async () => {
    await teach(5);
    await deliver(buildMail({ subject: "Filed", text: "WINNER!! free prize money $$$ click here offer payout" }), "z@mail.example.test");
    await trainWith(true, await idsOf("Filed"));

    const res = await json(await call("/api/junk", { method: "DELETE", cookie }));
    expect(res.junk).toMatchObject({ junk: 0, ham: 0, ready: false });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM junk_tokens").first<{ n: number }>())!.n).toBe(0);
    // The filing it did stays; only the learning goes.
    const row = await env.DB.prepare("SELECT box, trained FROM messages WHERE subject = 'Filed'").first<{ box: string; trained: string | null }>();
    expect(row).toMatchObject({ box: "junk", trained: null });
  }, 30_000);

  it("refuses a call with nothing to mark", async () => {
    expect((await call("/api/junk", { cookie, json: { ids: [] } })).status).toBe(400);
  });
});

describe("rules", () => {
  const setRules = (rules: unknown[]) => call("/api/rules", { method: "PUT", cookie, json: { rules } });
  const boxOf = (subject: string) =>
    env.DB.prepare("SELECT box, starred, read, deleted_at, box_reason FROM messages WHERE subject = ?1").bind(subject)
      .first<{ box: string; starred: number; read: number; deleted_at: number | null; box_reason: string | null }>();

  it("stars mail from a domain, matching subdomains too", async () => {
    await setRules([{ field: "from_domain", value: "bank.example", action: "star" }]);
    await deliver(buildMail({ from: "alerts@mail.bank.example", subject: "Statement" }), "a@mail.example.test");
    const row = await boxOf("Statement");
    expect(row?.starred).toBe(1);
    expect(row?.box).toBe("inbox");
  });

  it("applies every rule that matches, not just the first", async () => {
    await setRules([
      { field: "from_domain", value: "news.example", action: "star" },
      { field: "subject", value: "weekly", action: "read" },
    ]);
    await deliver(buildMail({ from: "hi@news.example", subject: "The weekly roundup" }), "a@mail.example.test");
    const row = await boxOf("The weekly roundup");
    expect(row).toMatchObject({ starred: 1, read: 1 });
  });

  it("stops at a rule that files the message", async () => {
    await setRules([
      { field: "subject", value: "offer", action: "bin" },
      { field: "from_domain", value: "shop.example", action: "star" },
    ]);
    await deliver(buildMail({ from: "deals@shop.example", subject: "An offer for you" }), "a@mail.example.test");
    const row = await boxOf("An offer for you");
    expect(row?.deleted_at).toBeGreaterThan(0);
    expect(row?.starred).toBe(0);
    expect(row?.box_reason).toMatch(/Your rule/);
  });

  it("junks on request and says which rule did it", async () => {
    await setRules([{ field: "from_address", value: "spam@bad.example", action: "junk" }]);
    await deliver(buildMail({ from: "spam@bad.example", subject: "Ruled junk" }), "a@mail.example.test");
    const row = await boxOf("Ruled junk");
    expect(row?.box).toBe("junk");
    expect(row?.box_reason).toMatch(/from spam@bad.example/);
  });

  it("lets a rule wave a sender past the Screener", async () => {
    await call("/api/settings", { method: "PUT", cookie, json: { screener: true } });
    await setRules([{ field: "from_domain", value: "trusted.example", action: "allow" }]);
    await deliver(buildMail({ from: "hello@trusted.example", subject: "Allowed" }), "guessed@mail.example.test");
    expect((await boxOf("Allowed"))?.box).toBe("inbox");
    // And a sender no rule mentions is still held.
    await deliver(buildMail({ from: "hello@other.example", subject: "Still held" }), "guessed@mail.example.test");
    expect((await boxOf("Still held"))?.box).toBe("screener");
  });

  it("ignores a rule that is switched off", async () => {
    await setRules([{ field: "subject", value: "quiet", action: "bin", enabled: false }]);
    await deliver(buildMail({ subject: "quiet please" }), "a@mail.example.test");
    expect((await boxOf("quiet please"))?.deleted_at).toBeNull();
  });

  it("matches an attachment without needing a value", async () => {
    await setRules([{ field: "has_attachment", value: "", action: "star" }]);
    await deliver(
      buildMail({ subject: "With a file", attachments: [{ name: "a.txt", type: "text/plain", bytes: new TextEncoder().encode("hi") }] }),
      "a@mail.example.test"
    );
    expect((await boxOf("With a file"))?.starred).toBe(1);
  });

  it("keeps the order it was given and refuses nonsense", async () => {
    const saved = await json(await setRules([
      { field: "subject", value: "one", action: "star" },
      { field: "subject", value: "two", action: "read" },
    ]));
    expect(saved.rules.map((r: any) => [r.position, r.value])).toEqual([[0, "one"], [1, "two"]]);

    expect((await setRules([{ field: "nope", value: "x", action: "star" }])).status).toBe(400);
    expect((await setRules([{ field: "subject", value: "x", action: "explode" }])).status).toBe(400);
    expect((await setRules([{ field: "subject", value: "  ", action: "star" }])).status).toBe(400);
    expect((await setRules(Array.from({ length: 21 }, () => ({ field: "subject", value: "x", action: "star" })))).status).toBe(400);
    // A rejected save changed nothing.
    expect((await json(await call("/api/rules", { cookie }))).rules).toHaveLength(2);
  });

  it("never lets a broken rules table lose mail", async () => {
    await env.DB.prepare("DROP TABLE rules").run();
    expect(await deliver(buildMail({ subject: "Survives" }), "a@mail.example.test")).toEqual([]);
    expect((await boxOf("Survives"))?.box).toBe("inbox");
  });
});
