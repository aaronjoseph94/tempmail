/** Web Push: subscriptions, VAPID, and the aes128gcm payload a browser can open. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64url, fromBase64url } from "../src/push";
import { buildMail, call, cookieFrom, deliver, env, freshDatabase, json, signIn } from "./helpers";

let cookie: string;
beforeEach(async () => {
  await freshDatabase();
  cookie = await signIn();
});
afterEach(() => vi.restoreAllMocks());

/** A browser-side subscription: an ECDH key pair and a 16-byte auth secret. */
async function fakeBrowser(endpoint = "https://push.example/send/abc") {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p256dh = base64url(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = base64url(crypto.getRandomValues(new Uint8Array(16)));
  return { endpoint, keys: { p256dh, auth }, pair, authBytes: fromBase64url(auth) };
}

/** Opens an aes128gcm body the way a browser does (the inverse of src/push.ts). */
async function decrypt(body: Uint8Array, browser: Awaited<ReturnType<typeof fakeBrowser>>): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);

  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", browser.pair.publicKey));
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, browser.pair.privateKey, 256);
  const enc = new TextEncoder();
  const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const hkdf = async (ikm: ArrayBuffer | Uint8Array, s: Uint8Array, info: Uint8Array, len: number) => {
    const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, k, len * 8));
  };
  const ikm = await hkdf(shared, browser.authBytes, cat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  expect(record[record.length - 1]).toBe(2);   // last-record delimiter
  return new TextDecoder().decode(record.slice(0, -1));
}

describe("subscriptions", () => {
  it("are behind the session gate", async () => {
    expect((await call("/api/push/key")).status).toBe(401);
    expect((await call("/api/push/subscriptions", { json: { endpoint: "https://x/y", keys: { p256dh: "a", auth: "b" } } })).status).toBe(401);
  });

  it("serves a stable VAPID public key that decodes to a P-256 point", async () => {
    const first = (await json(await call("/api/push/key", { cookie }))).key;
    const second = (await json(await call("/api/push/key", { cookie }))).key;
    expect(second).toBe(first);
    const raw = fromBase64url(first);
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(4);
  });

  it("registers, reports, replaces and removes a subscription", async () => {
    const browser = await fakeBrowser();
    expect((await call("/api/push/subscriptions", { cookie, json: { endpoint: browser.endpoint, keys: browser.keys } })).status).toBe(200);
    expect(await json(await call(`/api/push/subscriptions?endpoint=${encodeURIComponent(browser.endpoint)}`, { cookie }))).toEqual({ devices: 1, registered: true });
    expect((await call("/api/push/subscriptions", { cookie, json: { endpoint: browser.endpoint, keys: { p256dh: "new", auth: "keys" } } })).status).toBe(200);
    expect((await json(await call("/api/push/subscriptions", { cookie }))).devices).toBe(1);
    expect((await call("/api/push/subscriptions", { cookie, json: { endpoint: "http://insecure/x", keys: browser.keys } })).status).toBe(400);
    expect(await json(await call("/api/push/subscriptions", { cookie, method: "DELETE", json: { endpoint: browser.endpoint } }))).toEqual({ ok: true, removed: 1 });
    expect((await json(await call("/api/push/subscriptions", { cookie }))).devices).toBe(0);
  });
});

describe("a push on arrival", () => {
  it("carries a VAPID signature the served key verifies, and a payload the browser can open", async () => {
    const browser = await fakeBrowser();
    await call("/api/push/subscriptions", { cookie, json: { endpoint: browser.endpoint, keys: browser.keys } });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 201 }));

    await deliver(buildMail({ from: "GitHub <noreply@github.com>", subject: "Your code is 482913" }), "push@mail.example.test");
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(browser.endpoint);
    const headers = init.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers.ttl).toBe("120");
    expect(headers.urgency).toBe("high");

    // VAPID: "vapid t=<jwt>, k=<key>", with aud = the push service origin.
    const auth = headers.authorization.match(/^vapid t=([^,]+), k=(\S+)$/);
    expect(auth).not.toBeNull();
    const [h, c, sig] = auth![1].split(".");
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(c)));
    expect(claims.aud).toBe("https://push.example");
    expect(claims.sub).toBe("mailto:postmaster@mail.example.test");
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    expect(claims.exp).toBeLessThan(Date.now() / 1000 + 24 * 3600);
    const served = (await json(await call("/api/push/key", { cookie }))).key;
    expect(auth![2]).toBe(served);
    const verifyKey = await crypto.subtle.importKey("raw", fromBase64url(served), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, fromBase64url(sig), new TextEncoder().encode(`${h}.${c}`));
    expect(valid).toBe(true);

    const payload = JSON.parse(await decrypt(new Uint8Array(init.body as ArrayBuffer), browser));
    expect(payload).toMatchObject({ address: "push@mail.example.test", code: "482913", from: "GitHub", subject: "Your code is 482913" });
    const { messages } = await json(await call("/api/messages", { cookie }));
    expect(payload.id).toBe(messages[0].id);
  });

  it("forgets an endpoint the push service says is gone, and keeps one that merely failed", async () => {
    const gone = await fakeBrowser("https://push.example/send/gone");
    const flaky = await fakeBrowser("https://push.example/send/flaky");
    for (const b of [gone, flaky]) await call("/api/push/subscriptions", { cookie, json: { endpoint: b.endpoint, keys: b.keys } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response("", { status: String(input).endsWith("gone") ? 410 : 500 }));

    await deliver(buildMail(), "cleanup@mail.example.test");
    const rows = await env.DB.prepare("SELECT endpoint FROM push_subscriptions ORDER BY endpoint").all<{ endpoint: string }>();
    expect(rows.results.map((r) => r.endpoint)).toEqual(["https://push.example/send/flaky"]);
  });

  it("sends nothing when nobody subscribed", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await deliver(buildMail(), "quiet@mail.example.test");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("hardening", () => {
  it("refuses a push endpoint that points inside the network", async () => {
    const browser = await fakeBrowser();
    for (const endpoint of [
      "https://127.0.0.1/send", "https://[::1]/send", "https://[::ffff:169.254.169.254]/send",
      "https://10.0.0.5/send", "https://metadata.google.internal/send", "https://push.example:8443/send",
      "http://push.example/send",
    ]) {
      const res = await call("/api/push/subscriptions", { cookie, json: { endpoint, keys: browser.keys } });
      expect(res.status, endpoint).toBe(400);
    }
    expect((await json(await call("/api/push/subscriptions", { cookie }))).devices).toBe(0);
  });

  it("stops pushing to every device when the password changes", async () => {
    const browser = await fakeBrowser();
    await call("/api/push/subscriptions", { cookie, json: { endpoint: browser.endpoint, keys: browser.keys } });
    expect((await json(await call("/api/push/subscriptions", { cookie }))).devices).toBe(1);

    const res = await call("/api/password", { cookie, json: { currentPassword: "correct horse battery", newPassword: "a whole new secret" } });
    expect(res.status).toBe(200);
    cookie = cookieFrom(res);
    expect((await json(await call("/api/push/subscriptions", { cookie }))).devices).toBe(0);
  });

  it("keeps the key pair together and recovers from a corrupt one", async () => {
    // Concurrent first-callers must all end up with the same, matching pair.
    const keys = await Promise.all([1, 2, 3].map(async () => (await json(await call("/api/push/key", { cookie }))).key));
    expect(new Set(keys).size).toBe(1);

    // The signature the Worker actually sends must verify against the served key.
    const browser = await fakeBrowser();
    await call("/api/push/subscriptions", { cookie, json: { endpoint: browser.endpoint, keys: browser.keys } });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 201 }));
    await deliver(buildMail(), "pair@mail.example.test");
    const auth = ((spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>).authorization.match(/^vapid t=([^,]+), k=(\S+)$/)!;
    const [h, c, sig] = auth[1].split(".");
    expect(auth[2]).toBe(keys[0]);
    const verifyKey = await crypto.subtle.importKey("raw", fromBase64url(keys[0]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, fromBase64url(sig), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
    vi.restoreAllMocks();

    // A corrupt stored value regenerates instead of throwing a 500.
    await env.DB.prepare("UPDATE settings SET value = 'not json' WHERE key = 'vapid_keys'").run();
    const after = await call("/api/push/key", { cookie });
    expect(after.status).toBe(200);
    expect((await json(after)).key).not.toBe(keys[0]);
  });
});
