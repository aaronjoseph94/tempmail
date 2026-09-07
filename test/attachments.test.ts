/** Chunked attachment storage: the path that makes 25 MB mail useful. */
import { createScheduledController } from "cloudflare:test";
import worker from "../src/index";
import { beforeEach, describe, expect, it } from "vitest";
import { toBase64Chunks } from "../src/email";
import { ATTACHMENT_CHUNK_CHARS } from "../src/limits";
import { buildMail, call, deliver, env, freshDatabase, json, signIn } from "./helpers";

let cookie: string;
beforeEach(async () => {
  await freshDatabase();
  cookie = await signIn();
});

/** Deterministic bytes, so a round trip can be compared exactly. */
function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

async function fetchAttachment(id: string, idx: number, query = ""): Promise<Response> {
  return call(`/api/messages/${id}/attachments/${idx}${query}`, { cookie });
}

describe("base64 chunking", () => {
  it("splits on a 4-character boundary so each chunk decodes alone", () => {
    const chunks = toBase64Chunks(bytes(ATTACHMENT_CHUNK_CHARS * 2));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length % 4).toBe(0);
      expect(() => atob(chunk)).not.toThrow();
    }
  });

  it("round-trips exactly across chunk boundaries", () => {
    const source = bytes(ATTACHMENT_CHUNK_CHARS + 5000);
    const joined = toBase64Chunks(source).map((c) => atob(c)).join("");
    const back = Uint8Array.from(joined, (ch) => ch.charCodeAt(0));
    expect(back).toEqual(source);
  });

  it("handles empty input and a single byte", () => {
    expect(toBase64Chunks(new Uint8Array())).toEqual([]);
    expect(atob(toBase64Chunks(new Uint8Array([42]))[0])).toBe("*");
  });
});

describe("large attachments", () => {
  it("stores a 3 MB attachment across rows and streams it back byte-exact", async () => {
    const payload = bytes(3 * 1024 * 1024);
    await deliver(
      buildMail({ attachments: [{ name: "big.bin", type: "application/octet-stream", bytes: payload }] }),
      "big@mail.example.test"
    );

    const { messages } = await json(await call("/api/messages", { cookie }));
    const full = await json(await call(`/api/messages/${messages[0].id}`, { cookie }));
    expect(full.attachments[0]).toMatchObject({ filename: "big.bin", size: payload.length, stored: true });

    // More than one row, since D1 refuses anything near this size in one value.
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM attachment_chunks WHERE message_id = ?1"
    ).bind(messages[0].id).first<{ n: number }>();
    expect(rows!.n).toBeGreaterThan(1);

    const res = await fetchAttachment(messages[0].id, 0);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="big.bin"');
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.length).toBe(payload.length);
    expect(got).toEqual(payload);
  }, 120_000);

  it("accepts a message far larger than the old 2 MB ceiling", async () => {
    const rejected = await deliver(
      buildMail({ attachments: [{ name: "roomy.bin", type: "application/octet-stream", bytes: bytes(4 * 1024 * 1024) }] }),
      "roomy@mail.example.test"
    );
    expect(rejected).toEqual([]);
    expect((await json(await call("/api/messages", { cookie }))).messages).toHaveLength(1);
  }, 120_000);

  it("keeps metadata but no content once the per-message budget is spent", async () => {
    await call("/api/settings", { method: "PUT", cookie, json: { attachmentMb: 1 } });
    await deliver(
      buildMail({
        attachments: [
          { name: "kept.bin", type: "application/octet-stream", bytes: bytes(400 * 1024) },
          { name: "dropped.bin", type: "application/octet-stream", bytes: bytes(2 * 1024 * 1024) },
        ],
      }),
      "budget@mail.example.test"
    );
    const { messages } = await json(await call("/api/messages", { cookie }));
    const full = await json(await call(`/api/messages/${messages[0].id}`, { cookie }));
    expect(full.attachments[0]).toMatchObject({ filename: "kept.bin", stored: true });
    expect(full.attachments[1]).toMatchObject({ filename: "dropped.bin", stored: false, size: 2 * 1024 * 1024 });

    expect((await fetchAttachment(messages[0].id, 0)).status).toBe(200);
    expect((await fetchAttachment(messages[0].id, 1)).status).toBe(410); // gone, deliberately
  }, 120_000);

  it("serves an empty attachment as an empty file, not as one that was dropped", async () => {
    // Both an over-budget attachment and a genuinely 0-byte one have no chunk
    // rows; only the recorded size tells them apart.
    await deliver(
      buildMail({ attachments: [{ name: "empty.txt", type: "text/plain", bytes: new Uint8Array(0) }] }),
      "empty-att@mail.example.test"
    );
    const { messages } = await json(await call("/api/messages?address=empty-att@mail.example.test", { cookie }));
    const res = await fetchAttachment(messages[0].id, 0);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  }, 60_000);

  it("serves inline images inline and everything else as a download", async () => {
    await deliver(
      buildMail({
        html: '<img src="cid:pic@x">',
        attachments: [{ name: "pic.png", type: "image/png", bytes: bytes(2048), inline: true, cid: "pic@x" }],
      }),
      "inline@mail.example.test"
    );
    const { messages } = await json(await call("/api/messages", { cookie }));
    const full = await json(await call(`/api/messages/${messages[0].id}`, { cookie }));
    expect(full.attachments[0]).toMatchObject({ contentId: "pic@x", inline: true });

    const asImage = await fetchAttachment(messages[0].id, 0, "?inline=1");
    expect(asImage.headers.get("content-type")).toBe("image/png");
    expect(asImage.headers.get("content-disposition")).toMatch(/^inline;/);

    const asFile = await fetchAttachment(messages[0].id, 0);
    expect(asFile.headers.get("content-type")).toBe("application/octet-stream");
    expect(asFile.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("rejects nonsense indexes and unknown messages", async () => {
    await deliver(buildMail(), "x@mail.example.test");
    const { messages } = await json(await call("/api/messages", { cookie }));
    expect((await fetchAttachment(messages[0].id, 99)).status).toBe(404);
    expect((await fetchAttachment(messages[0].id, -1)).status).toBe(400);
    expect((await call(`/api/messages/${messages[0].id}/attachments/abc`, { cookie })).status).toBe(400);
    expect((await fetchAttachment("no-such-message", 0)).status).toBe(404);
  });

  it("quotes a filename containing quotes and newlines safely", async () => {
    await deliver(
      buildMail({ attachments: [{ name: 'we"ird\nname.txt', type: "text/plain", bytes: bytes(64) }] }),
      "odd@mail.example.test"
    );
    const { messages } = await json(await call("/api/messages", { cookie }));
    const header = (await fetchAttachment(messages[0].id, 0)).headers.get("content-disposition")!;
    expect(header).not.toContain('"we"');
    expect(header).not.toContain("\n");
  });

  it("deletes chunks along with the message, leaving nothing orphaned", async () => {
    await deliver(
      buildMail({ attachments: [{ name: "a.bin", type: "application/octet-stream", bytes: bytes(700 * 1024) }] }),
      "cleanup@mail.example.test"
    );
    const { messages } = await json(await call("/api/messages", { cookie }));
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM attachment_chunks").first<{ n: number }>();
    expect(before!.n).toBeGreaterThan(0);

    // Deleting moves the message to the trash: the bytes stay for the undo
    // window but can no longer be downloaded.
    await call(`/api/messages/${messages[0].id}`, { method: "DELETE", cookie });
    expect((await call(`/api/messages/${messages[0].id}/attachments/0`, { cookie })).status).toBe(404);
    const trashed = await env.DB.prepare("SELECT COUNT(*) AS n FROM attachment_chunks").first<{ n: number }>();
    expect(trashed!.n).toBe(before!.n);

    // Once the undo window has passed, the cron removes everything.
    await env.DB.prepare("UPDATE messages SET deleted_at = ?1").bind(Date.now() - 2 * 24 * 60 * 60 * 1000).run();
    await worker.scheduled(createScheduledController(), env, { waitUntil() {}, passThroughOnException() {} } as any);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM attachment_chunks").first<{ n: number }>();
    const metaAfter = await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments").first<{ n: number }>();
    expect(after!.n).toBe(0);
    expect(metaAfter!.n).toBe(0);
  }, 60_000);

  it("clears every chunk when the whole inbox is wiped", async () => {
    await deliver(buildMail({ attachments: [{ name: "a.bin", type: "text/plain", bytes: bytes(1000) }] }), "w1@mail.example.test");
    await deliver(buildMail({ attachments: [{ name: "b.bin", type: "text/plain", bytes: bytes(1000) }] }), "w2@mail.example.test");
    await call("/api/messages?all=1", { method: "DELETE", cookie });
    const chunks = await env.DB.prepare("SELECT COUNT(*) AS n FROM attachment_chunks").first<{ n: number }>();
    expect(chunks!.n).toBe(0);
  });
});
