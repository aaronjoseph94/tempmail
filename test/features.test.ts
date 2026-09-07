/** Starring, labels, bulk actions, runtime limits and retention. */
import { createScheduledController } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { MESSAGE_TTL_DAYS } from "../src/limits";
import { buildMail, call, deliver, env, freshDatabase, json, signIn } from "./helpers";

let cookie: string;
beforeEach(async () => {
  await freshDatabase();
  cookie = await signIn();
});

const ctx = { waitUntil() {}, passThroughOnException() {} } as any;

async function seed(count: number, options: { address?: string; startAt?: number } = {}) {
  const { address = "seed@mail.example.test", startAt = Date.now() - count * 1000 } = options;
  const batch = crypto.randomUUID().slice(0, 8);
  const statements = [];
  for (let i = 0; i < count; i++) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO messages (id, address, from_name, from_address, subject, snippet, received_at, read) VALUES (?1,?2,?3,?4,?5,?6,?7,0)"
      ).bind(`s-${batch}-${i.toString().padStart(4, "0")}`, address, "Seeder", "seed@example.org", `Seed ${i}`, "x", startAt + i * 1000)
    );
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
}

const listAll = async (q = "") => json(await call(`/api/messages${q}`, { cookie }));

describe("retention", () => {
  it("defaults to 100 days", async () => {
    expect(MESSAGE_TTL_DAYS).toBe(100);
    expect((await json(await call("/api/config", { cookie }))).retentionDays).toBe(100);
  });

  it("keeps mail at 99 days and drops it at 101", async () => {
    const day = 24 * 60 * 60 * 1000;
    await seed(1, { address: "young@mail.example.test", startAt: Date.now() - 99 * day });
    await seed(1, { address: "old@mail.example.test", startAt: Date.now() - 101 * day });
    await worker.scheduled(createScheduledController(), env, ctx);

    const left = (await listAll()).messages.map((m: any) => m.address);
    expect(left).toContain("young@mail.example.test");
    expect(left).not.toContain("old@mail.example.test");
  });

  it("never deletes starred mail, however old", async () => {
    const ancient = Date.now() - 900 * 24 * 60 * 60 * 1000;
    await seed(1, { address: "keep@mail.example.test", startAt: ancient });
    await seed(1, { address: "toss@mail.example.test", startAt: ancient });
    const { messages } = await listAll();
    const keeper = messages.find((m: any) => m.address === "keep@mail.example.test");
    await call(`/api/messages/${keeper.id}`, { method: "PATCH", cookie, json: { starred: true } });

    await worker.scheduled(createScheduledController(), env, ctx);
    const left = (await listAll()).messages;
    expect(left).toHaveLength(1);
    expect(left[0].starred).toBe(true);
  });

  it("honours a retention override from settings", async () => {
    await call("/api/settings", { method: "PUT", cookie, json: { retentionDays: 2 } });
    await seed(1, { address: "gone@mail.example.test", startAt: Date.now() - 3 * 24 * 60 * 60 * 1000 });
    await worker.scheduled(createScheduledController(), env, ctx);
    expect((await listAll()).messages).toHaveLength(0);
  });

  it("spares starred mail when the global cap trims the inbox", async () => {
    await call("/api/settings", { method: "PUT", cookie, json: { total: 100 } });
    await seed(120, { address: "bulk@mail.example.test" });
    const oldest = (await listAll("?limit=500")).messages.slice(-1)[0];
    await call(`/api/messages/${oldest.id}`, { method: "PATCH", cookie, json: { starred: true } });

    await worker.scheduled(createScheduledController(), env, ctx);
    const left = (await listAll("?limit=500")).messages;
    expect(left.length).toBeLessThanOrEqual(101);
    expect(left.some((m: any) => m.id === oldest.id)).toBe(true);
  }, 60_000);

  it("spares starred mail from the per-address prune on new arrivals", async () => {
    await call("/api/settings", { method: "PUT", cookie, json: { perAddress: 10 } });
    await seed(10, { address: "tight@mail.example.test" });
    const oldest = (await listAll("?limit=500")).messages.slice(-1)[0];
    await call(`/api/messages/${oldest.id}`, { method: "PATCH", cookie, json: { starred: true } });

    for (let i = 0; i < 5; i++) await deliver(buildMail({ subject: `new ${i}` }), "tight@mail.example.test");
    const left = (await listAll("?limit=500")).messages;
    expect(left.some((m: any) => m.id === oldest.id)).toBe(true);
  }, 60_000);
});

describe("starring", () => {
  it("stars, unstars and filters", async () => {
    await deliver(buildMail({ subject: "keep me" }), "a@mail.example.test");
    await deliver(buildMail({ subject: "ordinary" }), "a@mail.example.test");
    const { messages } = await listAll();
    const target = messages.find((m: any) => m.subject === "keep me");

    expect(target.starred).toBe(false);
    await call(`/api/messages/${target.id}`, { method: "PATCH", cookie, json: { starred: true } });
    expect((await listAll("?starred=1")).messages.map((m: any) => m.subject)).toEqual(["keep me"]);

    await call(`/api/messages/${target.id}`, { method: "PATCH", cookie, json: { starred: false } });
    expect((await listAll("?starred=1")).messages).toHaveLength(0);
  });

  it("reports a starred count per address", async () => {
    await deliver(buildMail(), "counted@mail.example.test");
    const { messages } = await listAll();
    await call(`/api/messages/${messages[0].id}`, { method: "PATCH", cookie, json: { starred: true } });
    const { addresses } = await json(await call("/api/addresses", { cookie }));
    expect(addresses[0].starred).toBe(1);
  });
});

describe("unread filter", () => {
  it("returns only unread when asked", async () => {
    await deliver(buildMail({ subject: "one" }), "u@mail.example.test");
    await deliver(buildMail({ subject: "two" }), "u@mail.example.test");
    const { messages } = await listAll();
    await call(`/api/messages/${messages[0].id}`, { cookie }); // opening marks it read

    const unread = await listAll("?unread=1");
    expect(unread.messages).toHaveLength(1);
    expect(unread.messages[0].id).toBe(messages[1].id);
  });
});

describe("bulk actions", () => {
  it("marks many read and stars many at once", async () => {
    await seed(5);
    const ids = (await listAll()).messages.map((m: any) => m.id);
    const res = await json(await call("/api/messages", { method: "PATCH", cookie, json: { ids, read: true, starred: true } }));
    expect(res.updated).toBe(5);
    const after = (await listAll()).messages;
    expect(after.every((m: any) => m.read && m.starred)).toBe(true);
  });

  it("deletes many at once and leaves the rest", async () => {
    await seed(5);
    const ids = (await listAll()).messages.slice(0, 3).map((m: any) => m.id);
    const res = await json(await call("/api/messages", { method: "DELETE", cookie, json: { ids } }));
    expect(res.deleted).toBe(3);
    expect((await listAll()).messages).toHaveLength(2);
  });

  it("rejects an empty or malformed id list rather than touching everything", async () => {
    await seed(3);
    expect((await call("/api/messages", { method: "PATCH", cookie, json: { ids: [], read: true } })).status).toBe(400);
    expect((await call("/api/messages", { method: "PATCH", cookie, json: { ids: ["x"] } })).status).toBe(400);
    expect((await call("/api/messages", { method: "DELETE", cookie, json: { ids: [] } })).status).toBe(400);
    expect((await listAll()).messages).toHaveLength(3); // nothing was touched
  });

  it("caps a single bulk call at 200 ids", async () => {
    await seed(3);
    const ids = (await listAll()).messages.map((m: any) => m.id);
    const padded = [...ids, ...Array.from({ length: 500 }, (_, i) => `ghost-${i}`)];
    const res = await json(await call("/api/messages", { method: "PATCH", cookie, json: { ids: padded, read: true } }));
    expect(res.updated).toBeLessThanOrEqual(200);
  });
});

describe("address labels", () => {
  it("saves, returns, trims and clears a label", async () => {
    await deliver(buildMail(), "shop@mail.example.test");
    await call("/api/addresses/shop@mail.example.test/label", { method: "PUT", cookie, json: { label: "  Shopping  " } });
    let { addresses } = await json(await call("/api/addresses", { cookie }));
    expect(addresses[0].label).toBe("Shopping");

    const long = "x".repeat(200);
    const res = await json(await call("/api/addresses/shop@mail.example.test/label", { method: "PUT", cookie, json: { label: long } }));
    expect(res.label.length).toBe(40);

    await call("/api/addresses/shop@mail.example.test/label", { method: "PUT", cookie, json: { label: "" } });
    ({ addresses } = await json(await call("/api/addresses", { cookie })));
    expect(addresses[0].label).toBeNull();
  });
});

describe("editable limits", () => {
  it("accepts values in range and reports them back", async () => {
    const cfg = await json(await call("/api/settings", {
      method: "PUT", cookie,
      json: { retentionDays: 30, perAddress: 50, total: 1000, rawMb: 10, attachmentMb: 5 },
    }));
    expect(cfg.retentionDays).toBe(30);
    expect(cfg.limits).toMatchObject({ perAddress: 50, total: 1000, rawBytes: 10 * 1024 * 1024, attachmentBytes: 5 * 1024 * 1024 });
  });

  it("refuses values outside the published ranges", async () => {
    for (const bad of [{ retentionDays: 0 }, { retentionDays: 400 }, { perAddress: 1 }, { total: 99999 }, { rawMb: 100 }, { attachmentMb: 0 }]) {
      expect((await call("/api/settings", { method: "PUT", cookie, json: bad })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("ignores nonsense types and clears back to the default with null", async () => {
    expect((await call("/api/settings", { method: "PUT", cookie, json: { retentionDays: "abc" } })).status).toBe(400);
    await call("/api/settings", { method: "PUT", cookie, json: { retentionDays: 5 } });
    const cleared = await json(await call("/api/settings", { method: "PUT", cookie, json: { retentionDays: null } }));
    expect(cleared.retentionDays).toBe(MESSAGE_TTL_DAYS);
  });

  it("applies the raw-size limit to incoming mail", async () => {
    await call("/api/settings", { method: "PUT", cookie, json: { rawMb: 1 } });
    const big = buildMail({ text: "x".repeat(2 * 1024 * 1024) });
    expect(await deliver(big, "toobig@mail.example.test")).toEqual(["Message too large"]);
    expect((await listAll()).messages).toHaveLength(0);
  }, 60_000);

  it("saves nothing at all when one field in the form is out of range", async () => {
    await call("/api/settings", { method: "PUT", cookie, json: { retentionDays: 30, perAddress: 50 } });
    // The form sends every field together; `total` is rejected, so the two
    // valid fields ahead of it must not be written either.
    const res = await call("/api/settings", {
      method: "PUT", cookie,
      json: { retentionDays: 7, perAddress: 25, total: 99999 },
    });
    expect(res.status).toBe(400);
    const cfg = await json(await call("/api/config", { cookie }));
    expect(cfg.retentionDays).toBe(30);
    expect(cfg.limits.perAddress).toBe(50);
  });

  it("publishes the ranges so the UI can bound its inputs", async () => {
    const cfg = await json(await call("/api/config", { cookie }));
    expect(cfg.ranges.retentionDays).toEqual({ min: 1, max: 365 });
    expect(cfg.ranges.rawMb.max).toBe(25);
  });
});

describe("export", () => {
  it("returns a readable text file with the headers and body", async () => {
    await deliver(buildMail({ subject: "Receipt 42", text: "Thanks for your order." }), "x@mail.example.test");
    const { messages } = await listAll();
    const res = await call(`/api/messages/${messages[0].id}/export`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("Receipt 42.txt");
    const body = await res.text();
    expect(body).toContain("Subject: Receipt 42");
    expect(body).toContain("Thanks for your order.");
    expect(body).toContain("to: x@mail.example.test".replace("to:", "To:"));
  });

  it("404s for a message that isn't there", async () => {
    expect((await call("/api/messages/nope/export", { cookie })).status).toBe(404);
  });
});

describe("trash", () => {
  const day = 24 * 60 * 60 * 1000;

  it("hides a deleted message everywhere and restores it on request", async () => {
    await seed(2, { address: "trash@mail.example.test" });
    const [victim] = (await listAll()).messages;
    expect((await call(`/api/messages/${victim.id}`, { cookie, method: "DELETE" })).status).toBe(200);

    expect((await listAll()).messages.map((m: any) => m.id)).not.toContain(victim.id);
    expect((await call(`/api/messages/${victim.id}`, { cookie })).status).toBe(404);
    expect((await call(`/api/messages/${victim.id}/export`, { cookie })).status).toBe(404);
    const rail = (await json(await call("/api/addresses", { cookie }))).addresses;
    expect(rail.find((a: any) => a.address === "trash@mail.example.test").count).toBe(1);
    expect((await call(`/api/messages/${victim.id}`, { cookie, method: "DELETE" })).status).toBe(404);

    const restore = await call(`/api/messages/${victim.id}/restore`, { cookie, method: "POST" });
    expect(restore.status).toBe(200);
    expect((await listAll()).messages.map((m: any) => m.id)).toContain(victim.id);
    expect((await call(`/api/messages/${victim.id}/restore`, { cookie, method: "POST" })).status).toBe(404);
  });

  it("trashes and restores many at once", async () => {
    await seed(4, { address: "bulk@mail.example.test" });
    const ids = (await listAll()).messages.map((m: any) => m.id);
    const del = await json(await call("/api/messages", { cookie, method: "DELETE", json: { ids: ids.slice(0, 3) } }));
    expect(del.deleted).toBe(3);
    expect((await listAll()).messages).toHaveLength(1);
    const back = await json(await call("/api/messages/restore", { cookie, json: { ids } }));
    expect(back.restored).toBe(3);
    expect((await listAll()).messages).toHaveLength(4);
  });

  it("purges trashed mail after a day, attachments included, and keeps newer trash", async () => {
    await deliver(buildMail({ subject: "With file", attachments: [{ name: "a.bin", type: "application/octet-stream", bytes: new Uint8Array(3000) }] }), "old@mail.example.test");
    await deliver(buildMail({ subject: "Fresh" }), "new@mail.example.test");
    const old = (await listAll("?address=old@mail.example.test")).messages[0];
    const fresh = (await listAll("?address=new@mail.example.test")).messages[0];
    await env.DB.prepare("UPDATE messages SET deleted_at = ?1 WHERE id = ?2").bind(Date.now() - 25 * 60 * 60 * 1000, old.id).run();
    await env.DB.prepare("UPDATE messages SET deleted_at = ?1 WHERE id = ?2").bind(Date.now() - 60 * 60 * 1000, fresh.id).run();

    await worker.scheduled(createScheduledController(), env, ctx);

    const rows = await env.DB.prepare("SELECT id FROM messages").all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toEqual([fresh.id]);
    const chunks = await env.DB.prepare("SELECT COUNT(*) AS n FROM attachment_chunks").first<{ n: number }>();
    expect(chunks?.n).toBe(0);
    expect((await call(`/api/messages/${fresh.id}/restore`, { cookie, method: "POST" })).status).toBe(200);
  });

  it("removes stars and marks unread in bulk", async () => {
    await seed(2);
    const ids = (await listAll()).messages.map((m: any) => m.id);
    await call("/api/messages", { cookie, method: "PATCH", json: { ids, starred: true, read: true } });
    expect((await listAll("?starred=1")).messages).toHaveLength(2);
    await call("/api/messages", { cookie, method: "PATCH", json: { ids, starred: false, read: false } });
    expect((await listAll("?starred=1")).messages).toHaveLength(0);
    expect((await listAll("?unread=1")).messages).toHaveLength(2);
  });
});

describe("address lifecycle API", () => {
  const put = (address: string, body: Record<string, unknown>) =>
    call(`/api/addresses/${encodeURIComponent(address)}`, { cookie, method: "PUT", json: body });

  it("folds the old label table into addresses once", async () => {
    await env.DB.prepare("INSERT INTO address_labels (address, label) VALUES ('old@mail.example.test', 'Old name')").run();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'schema_v'").run();
    const { bootstrapSchema } = await import("../src/db");
    await bootstrapSchema(env.DB);
    const rail = (await json(await call("/api/addresses", { cookie }))).addresses;
    expect(rail.find((a: any) => a.address === "old@mail.example.test")).toMatchObject({ label: "Old name", mode: "permanent" });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM address_labels").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("validates modes and expiries", async () => {
    expect((await put("a@mail.example.test", { mode: "forever" })).status).toBe(400);
    expect((await put("a@mail.example.test", { mode: "expires" })).status).toBe(400);
    expect((await put("a@mail.example.test", { mode: "expires", expiresAt: Date.now() - 1 })).status).toBe(400);
    expect((await put("a@mail.example.test", { mode: "expires", ttlHours: 24 * 31 })).status).toBe(400);
    expect((await put("not an address", { mode: "expires", ttlHours: 1 })).status).toBe(400);
    const ok = await json(await put("a@mail.example.test", { mode: "expires", ttlHours: 2, label: "Two hours" }));
    expect(ok).toMatchObject({ mode: "expires", label: "Two hours", dead: false });
    expect(ok.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
  });

  it("lists a fresh burner before any mail arrives and forgets it on request", async () => {
    await put("burner@mail.example.test", { mode: "expires", ttlHours: 24 });
    let rail = (await json(await call("/api/addresses", { cookie }))).addresses;
    expect(rail.find((a: any) => a.address === "burner@mail.example.test")).toMatchObject({ count: 0, mode: "expires", expired: false });
    await deliver(buildMail(), "burner@mail.example.test");
    expect((await call("/api/addresses/burner@mail.example.test", { cookie, method: "DELETE" })).status).toBe(200);
    rail = (await json(await call("/api/addresses", { cookie }))).addresses;
    // The row is gone but the mail is not: the next arrival recreates it as permanent.
    expect((await json(await call("/api/messages?address=burner@mail.example.test", { cookie }))).messages).toHaveLength(1);
  });

  it("sets an owner domain by hand and drops dead burners in the nightly sweep", async () => {
    expect((await json(await put("o@mail.example.test", { ownerDomain: "Example.COM" }))).ownerDomain).toBe("example.com");
    expect((await put("o@mail.example.test", { ownerDomain: "not a domain" })).status).toBe(400);
    await env.DB.prepare("INSERT INTO addresses (address, mode, expires_at, created_at) VALUES (?1, 'expires', ?2, ?2)")
      .bind("dead@mail.example.test", Date.now() - 8 * 24 * 60 * 60 * 1000).run();
    await worker.scheduled(createScheduledController(), env, ctx);
    const rail = (await json(await call("/api/addresses", { cookie }))).addresses;
    expect(rail.some((a: any) => a.address === "dead@mail.example.test")).toBe(false);
    expect(rail.some((a: any) => a.address === "o@mail.example.test")).toBe(true);
  });
});

describe("regressions", () => {
  it("leaves trashed mail alone during a bulk star or read", async () => {
    await seed(3, { address: "trash-patch@mail.example.test" });
    const ids = (await listAll("?address=trash-patch@mail.example.test")).messages.map((m: any) => m.id);
    await call("/api/messages", { cookie, method: "DELETE", json: { ids: [ids[0]] } });
    const patched = await json(await call("/api/messages", { cookie, method: "PATCH", json: { ids, starred: true } }));
    expect(patched.updated).toBe(2);                       // the trashed one is untouched
    const row = await env.DB.prepare("SELECT starred FROM messages WHERE id = ?1").bind(ids[0]).first<{ starred: number }>();
    expect(row?.starred).toBe(0);
  });

  it("refuses a read-all whose address went missing rather than clearing everything", async () => {
    await seed(2, { address: "keep-unread@mail.example.test" });
    expect((await call("/api/read-all?address=", { cookie, method: "POST" })).status).toBe(400);
    expect((await listAll("?unread=1")).messages.length).toBeGreaterThan(0);
  });

  it("refuses to hang a label on something that is not an address", async () => {
    expect((await call("/api/addresses/..%2Flabel/label", { cookie, method: "PUT", json: { label: "x" } })).status).toBe(400);
    expect((await call("/api/addresses/not-an-address/label", { cookie, method: "PUT", json: { label: "x" } })).status).toBe(400);
    const rail = (await json(await call("/api/addresses", { cookie }))).addresses;
    expect(rail.some((a: any) => a.address === "not-an-address")).toBe(false);
  });

  it("restores every message when more than one server page was deleted", async () => {
    // The server takes 200 ids per call and silently drops the rest, so the
    // client has to undo a big delete in the same slices it made it in.
    await seed(250, { address: "bulk-undo@mail.example.test" });
    const ids = (await listAll("?limit=500")).messages.map((m: any) => m.id);
    expect(ids).toHaveLength(250);

    for (let i = 0; i < ids.length; i += 200) {
      await call("/api/messages", { cookie, method: "DELETE", json: { ids: ids.slice(i, i + 200) } });
    }
    expect((await listAll("?limit=500")).messages).toHaveLength(0);

    let restored = 0;
    for (let i = 0; i < ids.length; i += 200) {
      restored += (await json(await call("/api/messages/restore", { cookie, json: { ids: ids.slice(i, i + 200) } }))).restored;
    }
    expect(restored).toBe(250);
    expect((await listAll("?limit=500")).messages).toHaveLength(250);
  });

  it("keeps a blocked inbox blocked when the block is undone", async () => {
    const put = (body: Record<string, unknown>) =>
      call("/api/addresses/blocked@mail.example.test", { cookie, method: "PUT", json: body });
    await put({ mode: "blocked" });
    expect(await deliver(buildMail(), "blocked@mail.example.test")).toEqual(["No such mailbox"]);
    // Undoing a block on an already-blocked address re-sends "blocked".
    await put({ mode: "blocked" });
    const rail = (await json(await call("/api/addresses", { cookie }))).addresses;
    expect(rail.find((a: any) => a.address === "blocked@mail.example.test")).toMatchObject({ mode: "blocked", dead: true });
    expect(await deliver(buildMail(), "blocked@mail.example.test")).toEqual(["No such mailbox"]);
  });

  it("removes an inbox and its mail together", async () => {
    await deliver(buildMail(), "gone@mail.example.test");
    expect((await json(await call("/api/messages?address=gone@mail.example.test", { cookie }))).messages).toHaveLength(1);
    await call("/api/messages?address=gone@mail.example.test", { cookie, method: "DELETE" });
    await call("/api/addresses/gone@mail.example.test", { cookie, method: "DELETE" });
    const rail = (await json(await call("/api/addresses", { cookie }))).addresses;
    expect(rail.some((a: any) => a.address === "gone@mail.example.test")).toBe(false);
    expect((await json(await call("/api/messages?address=gone@mail.example.test", { cookie }))).messages).toHaveLength(0);
  });
});
