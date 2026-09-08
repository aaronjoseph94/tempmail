import { createScheduledController } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { GLOBAL_MESSAGE_CAP, MAX_MESSAGES_PER_ADDRESS, MAX_RAW_BYTES } from "../src/limits";
import { buildMail, call, deliver, env, freshDatabase, json, signIn } from "./helpers";

let cookie: string;

beforeEach(async () => {
  await freshDatabase();
  cookie = await signIn();
});

async function listAll(query = "") {
  return json(await call(`/api/messages${query}`, { cookie }));
}

/** Inserts rows straight into D1 when the parsing pipeline isn't the point. */
async function seed(count: number, options: { address?: string; startAt?: number; read?: boolean } = {}) {
  const { address = "seed@mail.example.test", startAt = Date.now() - count * 1000, read = false } = options;
  const statements = [];
  const batch = crypto.randomUUID().slice(0, 8); // ids stay unique across several seed() calls
  for (let i = 0; i < count; i++) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO messages (id, address, from_name, from_address, subject, snippet, received_at, read) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
      ).bind(`seed-${batch}-${i.toString().padStart(4, "0")}`, address, "Seeder", "seed@example.org", `Seed ${i}`, `snippet ${i}`, startAt + i * 1000, read ? 1 : 0)
    );
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
}

describe("receiving mail", () => {
  it("stores a plain message with sender, subject, snippet and code", async () => {
    const rejected = await deliver(
      buildMail({ subject: "Your verification code", text: "Hi!\n\nYour code is 482913.\n\nThanks" }),
      "Quiet-Otter-42@Mail.Example.Test"
    );
    expect(rejected).toEqual([]);

    const { messages } = await listAll();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      address: "quiet-otter-42@mail.example.test",
      fromName: "Alice Example",
      fromAddress: "alice@example.org",
      subject: "Your verification code",
      snippet: "Hi! Your code is 482913. Thanks",
      code: "482913",
      read: false,
      hasAttachments: false,
    });
  });

  it("uses the envelope sender when the From header is missing", async () => {
    const raw = "Subject: bare\r\n\r\nno from header here";
    await deliver(raw, "x@mail.example.test", { from: "bounce@sender.example" });
    const { messages } = await listAll();
    expect(messages[0].fromAddress).toBe("bounce@sender.example");
    expect(messages[0].fromName).toBeNull();
  });

  it("keeps something readable even when the MIME is broken", async () => {
    await deliver("this is not even close to an email", "x@mail.example.test");
    const { messages } = await listAll();
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBeDefined();
  });

  it("falls back to (no subject) and an html-derived snippet", async () => {
    await deliver(buildMail({ subject: "", text: null, html: "<p>Only <b>html</b> here</p>" }), "x@mail.example.test");
    const { messages } = await listAll();
    expect(messages[0].subject).toBe("(no subject)");
    expect(messages[0].snippet).toBe("Only html here");
  });

  it("bounces mail for domains outside MAIL_DOMAIN and accepts subdomains inside it", async () => {
    const allow = { env: { MAIL_DOMAIN: "example.test, other.example" } };
    expect(await deliver(buildMail(), "a@mail.example.test", allow)).toEqual([]);
    expect(await deliver(buildMail(), "a@other.example", allow)).toEqual([]);
    expect(await deliver(buildMail(), "a@example.test.evil.net", allow)).toEqual(["No such mailbox"]);
    expect(await deliver(buildMail(), "a@unrelated.org", allow)).toEqual(["No such mailbox"]);
    expect((await listAll()).messages).toHaveLength(2);
  });

  it("ignores the old placeholder domain", async () => {
    expect(await deliver(buildMail(), "a@anything.test", { env: { MAIL_DOMAIN: "yourdomain.com" } })).toEqual([]);
  });

  it("bounces oversized messages before parsing them", async () => {
    const huge = buildMail({ text: "x".repeat(MAX_RAW_BYTES + 10) });
    expect(await deliver(huge, "big@mail.example.test")).toEqual(["Message too large"]);
    expect((await listAll()).messages).toHaveLength(0);
  });

  it("keeps attachment content, maps inline images, and honours the per-message budget", async () => {
    // A 1 MB budget: the first attachment fits, the second does not. Sizes stay
    // well inside the raw-message limit so the mail itself is still accepted.
    await call("/api/settings", { method: "PUT", cookie, json: { attachmentMb: 1 } });
    const small = new Uint8Array(40_000).map((_, i) => i % 251);
    const big = new Uint8Array(1_200_000);

    await deliver(buildMail({
      html: '<p>Logo: <img src="cid:logo@example"></p>',
      attachments: [
        { name: "logo.png", type: "image/png", bytes: small, inline: true, cid: "logo@example" },
        { name: "report.pdf", type: "application/pdf", bytes: big },
      ],
    }), "files@mail.example.test");

    const { messages } = await listAll();
    expect(messages[0].hasAttachments).toBe(true);
    const full = await json(await call(`/api/messages/${messages[0].id}`, { cookie }));
    expect(full.attachments).toHaveLength(2);

    const [logo, report] = full.attachments;
    expect(logo).toMatchObject({
      filename: "logo.png", contentType: "image/png", size: 40_000,
      contentId: "logo@example", inline: true, stored: true,
    });
    // Content streams from its own endpoint; check it survives the round trip,
    // including past the 32 KB mark where chunked base64 used to corrupt.
    const served = await call(`/api/messages/${messages[0].id}/attachments/0`, { cookie });
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(small);

    expect(report).toMatchObject({ filename: "report.pdf", size: big.length, stored: false });
  }, 60_000);

  it("prunes the oldest mail past the per-address cap as new mail arrives", async () => {
    await seed(MAX_MESSAGES_PER_ADDRESS, { address: "busy@mail.example.test" });
    await seed(3, { address: "calm@mail.example.test" });
    await deliver(buildMail({ subject: "one more" }), "busy@mail.example.test");

    const busy = await json(await call("/api/messages?address=busy@mail.example.test&limit=500", { cookie }));
    expect(busy.messages).toHaveLength(MAX_MESSAGES_PER_ADDRESS);
    expect(busy.messages[0].subject).toBe("one more");
    expect(busy.messages.some((m: any) => m.subject === "Seed 0")).toBe(false); // the oldest went
    expect((await json(await call("/api/messages?address=calm@mail.example.test", { cookie }))).messages).toHaveLength(3);
  });

  it("accepts mail through the dev ingest endpoint only with the right key", async () => {
    const raw = buildMail({ subject: "via dev" });
    const noKey = await call("/api/dev/ingest?to=dev@mail.example.test", { method: "POST", body: raw, cookie });
    expect(noKey.status).toBe(404);
    const badKey = await call("/api/dev/ingest?to=dev@mail.example.test", { method: "POST", body: raw, cookie, headers: { "x-ingest-key": "wrong" }, env: { INGEST_KEY: "dev-key" } });
    expect(badKey.status).toBe(404);
    // No session needed: the key is the credential (handy for curl during development).
    const ok = await call("/api/dev/ingest?to=dev@mail.example.test", { method: "POST", body: raw, headers: { "x-ingest-key": "dev-key" }, env: { INGEST_KEY: "dev-key" } });
    expect(ok.status).toBe(200);
    expect((await listAll()).messages[0].subject).toBe("via dev");
  });
});

describe("the message list", () => {
  it("pages newest-first with a stable cursor", async () => {
    await seed(120);
    const first = await listAll("?limit=50");
    expect(first.messages).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.messages[0].subject).toBe("Seed 119");

    const second = await listAll(`?limit=50&cursor=${encodeURIComponent(first.nextCursor)}`);
    expect(second.messages[0].subject).toBe("Seed 69");
    const third = await listAll(`?limit=50&cursor=${encodeURIComponent(second.nextCursor)}`);
    expect(third.messages).toHaveLength(20);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();

    const ids = new Set([...first.messages, ...second.messages, ...third.messages].map((m: any) => m.id));
    expect(ids.size).toBe(120);
  });

  it("does not skip or repeat rows that share a timestamp", async () => {
    await seed(5, { startAt: 1_700_000_000_000 });
    await env.DB.prepare("UPDATE messages SET received_at = 1700000000000").run();
    const page1 = await listAll("?limit=2");
    const page2 = await listAll(`?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`);
    const page3 = await listAll(`?limit=2&cursor=${encodeURIComponent(page2.nextCursor)}`);
    const ids = [...page1.messages, ...page2.messages, ...page3.messages].map((m: any) => m.id);
    expect(new Set(ids).size).toBe(5);
    expect(page3.hasMore).toBe(false);
  });

  it("rejects a malformed cursor and clamps the page size", async () => {
    expect((await call("/api/messages?cursor=garbage", { cookie })).status).toBe(400);
    await seed(3);
    expect((await listAll("?limit=0")).messages).toHaveLength(1);
    expect((await listAll("?limit=9999")).messages).toHaveLength(3);
    expect((await listAll("?limit=abc")).messages).toHaveLength(3);
  });

  it("searches subject, sender, recipient and snippet without LIKE surprises", async () => {
    await deliver(buildMail({ subject: "Meeting 100% confirmed", text: "see you" }), "a@mail.example.test");
    await deliver(buildMail({ subject: "Other", text: "the under_score case", from: "Bob <bob@example.org>" }), "b@mail.example.test");
    await deliver(buildMail({ subject: "Third", text: "nothing" }), "carol-xyz@mail.example.test");

    expect((await listAll("?q=100%25")).messages.map((m: any) => m.subject)).toEqual(["Meeting 100% confirmed"]);
    expect((await listAll("?q=under_score")).messages.map((m: any) => m.subject)).toEqual(["Other"]);
    expect((await listAll("?q=bob")).messages.map((m: any) => m.subject)).toEqual(["Other"]);
    expect((await listAll("?q=carol-xyz")).messages.map((m: any) => m.subject)).toEqual(["Third"]);
    expect((await listAll("?q=%25")).messages).toHaveLength(1); // a literal percent sign, not a wildcard
    expect((await listAll("?q=zzz")).messages).toHaveLength(0);
  });

  it("filters by address case-insensitively", async () => {
    await deliver(buildMail(), "one@mail.example.test");
    await deliver(buildMail(), "two@mail.example.test");
    const one = await listAll("?address=ONE@mail.example.test");
    expect(one.messages).toHaveLength(1);
    expect(one.messages[0].address).toBe("one@mail.example.test");
  });
});

describe("reading and housekeeping", () => {
  it("opening a message marks it read; PATCH can mark it unread again", async () => {
    await deliver(buildMail({ text: "Body text", html: "<b>Body</b>" }), "r@mail.example.test");
    const { messages } = await listAll();
    const id = messages[0].id;

    const full = await json(await call(`/api/messages/${id}`, { cookie }));
    expect(full.textBody.trim()).toBe("Body text");
    expect(full.htmlBody.trim()).toBe("<b>Body</b>");
    expect((await listAll()).messages[0].read).toBe(true);

    const addresses = await json(await call("/api/addresses", { cookie }));
    expect(addresses.addresses).toHaveLength(1);
    expect(addresses.addresses[0]).toMatchObject(
      { address: "r@mail.example.test", label: null, count: 1, unread: 0, starred: 0, lastReceivedAt: full.receivedAt, mode: "permanent" }
    );

    expect((await call(`/api/messages/${id}`, { cookie, method: "PATCH", json: { read: false } })).status).toBe(200);
    expect((await listAll()).messages[0].read).toBe(false);
    expect((await call(`/api/messages/${id}`, { cookie, method: "PATCH", json: {} })).status).toBe(400);
    expect((await call("/api/messages/missing", { cookie, method: "PATCH", json: { read: true } })).status).toBe(404);
    expect((await call("/api/messages/missing", { cookie })).status).toBe(404);
  });

  it("marks everything or one address as read", async () => {
    await seed(3, { address: "a@mail.example.test" });
    await seed(2, { address: "b@mail.example.test" });
    await call("/api/read-all?address=a@mail.example.test", { method: "POST", cookie });
    let { addresses } = await json(await call("/api/addresses", { cookie }));
    expect(addresses.find((x: any) => x.address === "a@mail.example.test").unread).toBe(0);
    expect(addresses.find((x: any) => x.address === "b@mail.example.test").unread).toBe(2);
    await call("/api/read-all", { method: "POST", cookie });
    ({ addresses } = await json(await call("/api/addresses", { cookie })));
    expect(addresses.every((x: any) => x.unread === 0)).toBe(true);
  });

  it("deletes one message, one address, or everything (but only when asked explicitly)", async () => {
    await seed(3, { address: "a@mail.example.test" });
    await seed(2, { address: "b@mail.example.test" });
    const { messages } = await listAll();
    const oneOfB = messages.find((m: any) => m.address === "b@mail.example.test");
    expect((await call(`/api/messages/${oneOfB.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await listAll()).messages).toHaveLength(4);

    expect((await call("/api/messages", { method: "DELETE", cookie })).status).toBe(400);
    expect((await listAll()).messages).toHaveLength(4);

    const wiped = await json(await call("/api/messages?address=a@mail.example.test", { method: "DELETE", cookie }));
    expect(wiped.deleted).toBe(3);
    const left = (await listAll()).messages;
    expect(left).toHaveLength(1);
    expect(left[0].address).toBe("b@mail.example.test");

    expect((await call("/api/messages?all=1", { method: "DELETE", cookie })).status).toBe(200);
    expect((await listAll()).messages).toHaveLength(0);
  });

  it("returns 400 rather than 500 for a malformed message id", async () => {
    expect((await call("/api/messages/%E0%A4%A", { cookie })).status).toBe(400);
  });

  it("the nightly job drops old mail and enforces the global cap", async () => {
    const old = Date.now() - 61 * 24 * 60 * 60 * 1000;
    await seed(5, { address: "old@mail.example.test", startAt: old });
    await seed(GLOBAL_MESSAGE_CAP + 10, { address: "recent@mail.example.test" });

    await worker.scheduled(createScheduledController(), env, { waitUntil() {}, passThroughOnException() {} } as any);

    const { results } = await env.DB.prepare("SELECT address, COUNT(*) AS n FROM messages GROUP BY address").all<{ address: string; n: number }>();
    expect(results.find((r) => r.address === "old@mail.example.test")).toBeUndefined();
    expect(results.find((r) => r.address === "recent@mail.example.test")?.n).toBe(GLOBAL_MESSAGE_CAP);
  }, 30_000);

  it("reports the domain it learned from incoming mail", async () => {
    let config = await json(await call("/api/config", { cookie }));
    expect(config.mailDomain).toBeNull();
    await deliver(buildMail(), "hello@seen.example");
    config = await json(await call("/api/config", { cookie }));
    expect(config.mailDomain).toBe("seen.example");
    expect(config.domainSource).toBe("observed");

    // A setting beats what we observed; MAIL_DOMAIN beats both.
    await call("/api/settings", { method: "PUT", cookie, json: { mailDomain: "chosen.example" } });
    config = await json(await call("/api/config", { cookie }));
    expect(config.mailDomain).toBe("chosen.example");
    config = await json(await call("/api/config", { cookie, env: { MAIL_DOMAIN: "forced.example" } }));
    expect(config.mailDomain).toBe("forced.example");
    expect(config.domainSource).toBe("env");

    expect((await call("/api/settings", { method: "PUT", cookie, json: { mailDomain: "nope nope" } })).status).toBe(400);
    await call("/api/settings", { method: "PUT", cookie, json: { mailDomain: "" } });
    config = await json(await call("/api/config", { cookie }));
    expect(config.domainSource).toBe("observed");
  });

  const put = (json_: Record<string, unknown>) => call("/api/settings", { method: "PUT", cookie, json: json_ });
  const domains = async () => (await json(await call("/api/config", { cookie }))).mailDomains;

  it("keeps several domains, default first", async () => {
    await put({ mailDomains: [" One.Example ", "two.example"] });
    expect(await domains()).toEqual(["one.example", "two.example"]);
    const config = await json(await call("/api/config", { cookie }));
    expect(config.mailDomain).toBe("one.example");
    expect(config.domainSource).toBe("settings");
  });

  it("drops duplicates and refuses a list that is not domains", async () => {
    await put({ mailDomains: ["a.example", "A.example", "b.example"] });
    expect(await domains()).toEqual(["a.example", "b.example"]);
    expect((await put({ mailDomains: ["fine.example", "not a domain"] })).status).toBe(400);
    // The rejected write changed nothing.
    expect(await domains()).toEqual(["a.example", "b.example"]);
    expect((await put({ mailDomains: "a.example" })).status).toBe(400);
    expect((await put({ mailDomains: Array.from({ length: 11 }, (_, i) => `d${i}.example`) })).status).toBe(400);
  });

  it("treats the old single-domain call as choosing the default", async () => {
    await put({ mailDomains: ["a.example", "b.example"] });
    // An older client that only knows about one domain must not silently drop
    // the others; naming one promotes it instead.
    await put({ mailDomain: "b.example" });
    expect(await domains()).toEqual(["b.example", "a.example"]);
    // A domain the list had never heard of joins it at the front.
    await put({ mailDomain: "c.example" });
    expect(await domains()).toEqual(["c.example", "b.example", "a.example"]);
    // Clearing still clears everything.
    await put({ mailDomain: "" });
    expect(await domains()).toEqual([]);
  });

  it("reads a database that only ever had the single setting", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('mail_domain', 'legacy.example')").run();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'mail_domains'").run();
    expect(await domains()).toEqual(["legacy.example"]);
  });

  it("lets MAIL_DOMAIN override the stored list entirely", async () => {
    await put({ mailDomains: ["stored.example"] });
    const config = await json(await call("/api/config", { cookie, env: { MAIL_DOMAIN: "one.forced, two.forced" } }));
    expect(config.mailDomains).toEqual(["one.forced", "two.forced"]);
    expect(config.domainSource).toBe("env");
    // And the list is still only about display: what is accepted is unchanged.
    expect(await deliver(buildMail(), "x@stored.example", { env: { MAIL_DOMAIN: "one.forced" } })).toEqual(["No such mailbox"]);
  });
});

describe("address lifecycles", () => {
  const rail = async () => (await json(await call("/api/addresses", { cookie }))).addresses;
  const setMode = (address: string, body: Record<string, unknown>) =>
    call(`/api/addresses/${encodeURIComponent(address)}`, { cookie, method: "PUT", json: body });

  it("gives an unknown address a permanent row owned by its first sender", async () => {
    expect(await deliver(buildMail({ from: "GitHub <noreply@github.com>" }), "new@mail.example.test")).toEqual([]);
    const [row] = await rail();
    expect(row).toMatchObject({ address: "new@mail.example.test", mode: "permanent", ownerDomain: "github.com", count: 1, dead: false, leaks: [] });
  });

  it("bounces mail once an expiring address has expired, and accepts it before", async () => {
    await env.DB.prepare("INSERT INTO addresses (address, mode, expires_at, created_at) VALUES (?1, 'expires', ?2, ?3)")
      .bind("gone@mail.example.test", Date.now() - 1000, Date.now() - 100000).run();
    expect(await deliver(buildMail(), "gone@mail.example.test")).toEqual(["No such mailbox"]);
    await setMode("soon@mail.example.test", { mode: "expires", ttlHours: 24 });
    expect(await deliver(buildMail(), "soon@mail.example.test")).toEqual([]);
    expect((await rail()).find((a: any) => a.address === "gone@mail.example.test")).toMatchObject({ expired: true, count: 0 });
  });

  it("refuses mail to a blocked address without storing anything", async () => {
    await setMode("spam@mail.example.test", { mode: "blocked" });
    expect(await deliver(buildMail(), "spam@mail.example.test")).toEqual(["No such mailbox"]);
    const { messages } = await json(await call("/api/messages", { cookie }));
    expect(messages).toHaveLength(0);
    await setMode("spam@mail.example.test", { mode: "permanent" });
    expect(await deliver(buildMail(), "spam@mail.example.test")).toEqual([]);
  });

  it("reports senders that are not the owner as leaks, ignoring the owner's subdomains", async () => {
    await deliver(buildMail({ from: "Shop <orders@example.org>" }), "shop@mail.example.test");
    await deliver(buildMail({ from: "Shop <news@mail.example.org>" }), "shop@mail.example.test");
    await deliver(buildMail({ from: "Spammer <x@sketchy.net>" }), "shop@mail.example.test");
    await deliver(buildMail({ from: "Spammer <y@sketchy.net>" }), "shop@mail.example.test");
    const row = (await rail()).find((a: any) => a.address === "shop@mail.example.test");
    expect(row.ownerDomain).toBe("example.org");
    expect(row.leaks).toEqual([{ domain: "sketchy.net", count: 2, last: expect.any(Number) }]);
  });
});
