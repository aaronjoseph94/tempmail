/** Kept headers: authentication verdicts, threading ids, and one-click unsubscribe. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAuthResults, parseListUnsubscribe, publicHttpsUrl } from "../src/headers";
import { buildMail, call, deliver, freshDatabase, json, signIn } from "./helpers";

let cookie: string;
beforeEach(async () => {
  await freshDatabase();
  cookie = await signIn();
});
afterEach(() => vi.restoreAllMocks());

const CF_AR = "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=github.com header.s=pf2023; spf=pass (mx.cloudflare.net: domain of noreply@github.com designates 192.30.252.1 as permitted sender) smtp.mailfrom=noreply@github.com; dmarc=pass header.from=github.com";

async function firstMessage() {
  const { messages } = await json(await call("/api/messages", { cookie }));
  return json(await call(`/api/messages/${messages[0].id}`, { cookie }));
}

describe("parsers", () => {
  it("summarises Cloudflare's authentication results", () => {
    expect(parseAuthResults(CF_AR.slice("Authentication-Results: ".length))).toEqual({ dkim: "pass", spf: "pass", dmarc: "pass" });
    expect(parseAuthResults("mx.cloudflare.net; spf=softfail smtp.mailfrom=x; dkim=fail (bad signature); dmarc=fail policy.p=reject")).toEqual({ spf: "softfail", dkim: "fail", dmarc: "fail" });
    expect(parseAuthResults("mx.cloudflare.net; none")).toBeNull();
    expect(parseAuthResults(null)).toBeNull();
  });

  it("picks the https and mailto unsubscribe links apart", () => {
    expect(parseListUnsubscribe("<mailto:leave@list.example>, <https://list.example/u?id=7>")).toEqual({ https: "https://list.example/u?id=7", mailto: "mailto:leave@list.example" });
    expect(parseListUnsubscribe("<http://insecure.example/u>")).toBeNull();
    expect(parseListUnsubscribe("")).toBeNull();
  });

  it("only lets the Worker call public https hosts, refusing every IP literal", () => {
    expect(publicHttpsUrl("https://list.example/u?id=7")?.hostname).toBe("list.example");
    for (const bad of [
      "http://list.example/u", "https://127.0.0.1/u", "https://10.0.0.1/u", "https://172.20.1.1/u", "https://192.168.1.1/u",
      "https://169.254.169.254/latest", "https://100.64.0.1/u", "https://[::1]/u", "https://[fd00::1]/u", "https://localhost/u",
      "https://foo.local/u", "https://user:pw@list.example/u", "https://list.example:8443/u", "not a url",
      // IPv4-mapped IPv6: URL rewrites the host to hex, so a filter written
      // against the dotted-quad spelling never sees these.
      "https://[::ffff:127.0.0.1]/u", "https://[::ffff:169.254.169.254]/u", "https://[::ffff:10.0.0.5]/u",
      // Names that resolve only inside a network, and bare labels with no TLD.
      "https://metadata.google.internal/computeMetadata/v1/", "https://metadata/v1", "https://router.home/u",
    ]) expect(publicHttpsUrl(bad), bad).toBeNull();
  });
});

describe("headers kept at ingest", () => {
  it("stores threading ids, the sender's date and reply-to", async () => {
    await deliver(buildMail({
      messageId: "<abc@example.org>", date: "Tue, 01 Sep 2026 10:00:00 +0000",
      headers: ["In-Reply-To: <parent@example.org>", "References: <root@example.org> <parent@example.org>", "Reply-To: Replies <replies@example.org>"],
    }), "t@mail.example.test");
    const msg = await firstMessage();
    expect(msg).toMatchObject({ messageId: "<abc@example.org>", inReplyTo: "<parent@example.org>", replyTo: "replies@example.org", sentAt: Date.parse("Tue, 01 Sep 2026 10:00:00 +0000") });
    const exported = await (await call(`/api/messages/${msg.id}/export`, { cookie })).text();
    expect(exported).toContain("Message-ID: <abc@example.org>");
    expect(exported).toContain("Date: Tue, 01 Sep 2026 10:00:00 GMT");
  });

  it("keeps Cloudflare's verdicts and ignores a forged second header", async () => {
    await deliver(buildMail({ headers: [CF_AR, "Authentication-Results: evil.example; dkim=pass; spf=pass; dmarc=pass"] }), "a@mail.example.test");
    expect((await firstMessage()).auth).toEqual({ dkim: "pass", spf: "pass", dmarc: "pass" });

    await freshDatabase(); cookie = await signIn();
    await deliver(buildMail({ headers: ["Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom=x; dkim=none; dmarc=fail", CF_AR] }), "b@mail.example.test");
    expect((await firstMessage()).auth).toEqual({ spf: "fail", dkim: "none", dmarc: "fail" });
  });

  it("reports no verdict for mail that carried none, and no unsubscribe when absent", async () => {
    await deliver(buildMail(), "c@mail.example.test");
    const msg = await firstMessage();
    expect(msg.auth).toBeNull();
    expect(msg.unsubscribe).toBeNull();
    expect((await call(`/api/messages/${msg.id}/unsubscribe`, { cookie, method: "POST" })).status).toBe(404);
  });
});

describe("one-tap unsubscribe", () => {
  it("makes the RFC 8058 one-click request itself", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 202 }));
    await deliver(buildMail({ headers: ["List-Unsubscribe: <https://list.example/u?id=7>, <mailto:leave@list.example>", "List-Unsubscribe-Post: List-Unsubscribe=One-Click"] }), "n@mail.example.test");
    const msg = await firstMessage();
    expect(msg.unsubscribe).toEqual({ oneClick: true, https: "https://list.example/u?id=7", mailto: "mailto:leave@list.example" });

    const res = await call(`/api/messages/${msg.id}/unsubscribe`, { cookie, method: "POST" });
    expect(await json(res)).toMatchObject({ ok: true, method: "post", status: 202 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://list.example/u?id=7");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("List-Unsubscribe=One-Click");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(init.redirect).toBe("manual");
  });

  it("hands a plain link back to the client without calling it", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await deliver(buildMail({ headers: ["List-Unsubscribe: <https://list.example/leave>"] }), "o@mail.example.test");
    const msg = await firstMessage();
    expect(msg.unsubscribe.oneClick).toBe(false);
    expect(await json(await call(`/api/messages/${msg.id}/unsubscribe`, { cookie, method: "POST" }))).toEqual({ ok: true, method: "open", url: "https://list.example/leave" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("falls back to mailto, and refuses links into private networks", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await deliver(buildMail({ headers: ["List-Unsubscribe: <mailto:leave@list.example>"] }), "m@mail.example.test");
    let msg = await firstMessage();
    expect(await json(await call(`/api/messages/${msg.id}/unsubscribe`, { cookie, method: "POST" }))).toEqual({ ok: true, method: "mailto", url: "mailto:leave@list.example" });

    await freshDatabase(); cookie = await signIn();
    await deliver(buildMail({ headers: ["List-Unsubscribe: <https://169.254.169.254/latest/meta-data>", "List-Unsubscribe-Post: List-Unsubscribe=One-Click"] }), "s@mail.example.test");
    msg = await firstMessage();
    expect((await call(`/api/messages/${msg.id}/unsubscribe`, { cookie, method: "POST" })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports a sender whose service fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await deliver(buildMail({ headers: ["List-Unsubscribe: <https://list.example/u>", "List-Unsubscribe-Post: List-Unsubscribe=One-Click"] }), "f@mail.example.test");
    const msg = await firstMessage();
    const res = await call(`/api/messages/${msg.id}/unsubscribe`, { cookie, method: "POST" });
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ ok: false, method: "post", status: 500 });
  });
});
