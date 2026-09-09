import { beforeEach, describe, expect, it } from "vitest";
import { call, cookieFrom, freshDatabase, freshIp, json, signIn, ORIGIN } from "./helpers";

beforeEach(freshDatabase);

describe("first-run setup", () => {
  it("reports that setup is required on a fresh database", async () => {
    // The exact shape, so a field added here is a deliberate change: the
    // sign-in page reads this before any session exists, and it is the only
    // endpoint that answers then.
    const status = await json(await call("/api/status"));
    expect(status).toEqual({ authed: false, setupRequired: true, passwordSource: "none", brandName: "Temp Email", passkeys: 0 });
  });

  it("refuses to sign in before a password exists", async () => {
    const res = await call("/api/login", { json: { password: "whatever" } });
    expect(res.status).toBe(409);
    expect((await json(res)).setupRequired).toBe(true);
  });

  it("rejects weak passwords and bad domains", async () => {
    expect((await call("/api/setup", { json: { password: "short" } })).status).toBe(400);
    expect((await call("/api/setup", { json: { password: 12345678 } })).status).toBe(400);
    expect((await call("/api/setup", { json: { password: "long enough", mailDomain: "not a domain" } })).status).toBe(400);
    expect((await json(await call("/api/status"))).setupRequired).toBe(true);
  });

  it("creates the password, records the domain and signs the caller in", async () => {
    const res = await call("/api/setup", { json: { password: "correct horse battery", mailDomain: " Example.COM " } });
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res);
    expect(cookie).toMatch(/^__Host-tm_session=\d+\.[0-9a-f]{64}$/);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly; Secure; Path=/; SameSite=Lax");

    const config = await json(await call("/api/config", { cookie }));
    expect(config.mailDomain).toBe("example.com");
    expect(config.domainSource).toBe("settings");
    expect(config.passwordSource).toBe("database");
  });

  it("only runs once", async () => {
    await signIn();
    const again = await call("/api/setup", { json: { password: "another password" } });
    expect(again.status).toBe(409);
    expect((await json(await call("/api/status"))).setupRequired).toBe(false);
  });
});

describe("signing in", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    await signIn("correct horse battery");
    const ip = freshIp();
    const wrong = await call("/api/login", { json: { password: "wrong" }, ip });
    expect(wrong.status).toBe(401);
    expect((await json(wrong)).error).toBe("Wrong password. 4 attempts left.");

    const right = await call("/api/login", { json: { password: "correct horse battery" }, ip });
    expect(right.status).toBe(200);
    const me = await json(await call("/api/status", { cookie: cookieFrom(right) }));
    expect(me.authed).toBe(true);
  });

  it("locks an IP out after five failures and says so on the fifth", async () => {
    await signIn();
    const ip = freshIp();
    let last: Response | undefined;
    for (let i = 0; i < 5; i++) last = await call("/api/login", { json: { password: "nope" }, ip });
    expect(last!.status).toBe(401);
    expect((await json(last!)).error).toBe("Wrong password. Locked out for 15 minutes.");

    const blocked = await call("/api/login", { json: { password: "correct horse battery" }, ip });
    expect(blocked.status).toBe(429);
    expect((await json(blocked)).error).toMatch(/^Too many attempts/);

    // Another IP is unaffected.
    const other = await call("/api/login", { json: { password: "correct horse battery" }, ip: freshIp() });
    expect(other.status).toBe(200);
  }, 15_000);

  it("does not let a mistyped current password lock the account out of signing in", async () => {
    const cookie = await signIn("correct horse battery");
    const ip = freshIp();
    // Five wrong tries in Settings by someone who is already signed in.
    for (let i = 0; i < 5; i++) {
      const res = await call("/api/password", { cookie, ip, json: { currentPassword: "nope", newPassword: "a much longer one" } });
      expect([401, 429]).toContain(res.status);
    }
    expect((await call("/api/password", { cookie, ip, json: { currentPassword: "nope", newPassword: "a much longer one" } })).status).toBe(429);

    // Signing in from that same IP still works: the two gates count separately.
    expect((await call("/api/login", { json: { password: "correct horse battery" }, ip })).status).toBe(200);
  }, 15_000);

  it("treats a missing or malformed body as a wrong password, not a crash", async () => {
    await signIn();
    const res = await call("/api/login", { method: "POST", body: "not json", headers: { "content-type": "application/json" }, ip: freshIp() });
    expect(res.status).toBe(401);
  });
});

describe("sessions", () => {
  it("rejects forged, expired and mangled cookies", async () => {
    const cookie = await signIn();
    const [name, value] = cookie.split("=");
    const [expiry, signature] = value.split(".");

    const tampered = `${name}=${Number(expiry) + 1000}.${signature}`;
    expect((await call("/api/config", { cookie: tampered })).status).toBe(401);

    const flipped = `${name}=${expiry}.${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    expect((await call("/api/config", { cookie: flipped })).status).toBe(401);

    const expired = `${name}=${Date.now() - 1000}.${signature}`;
    expect((await call("/api/config", { cookie: expired })).status).toBe(401);

    for (const junk of [`${name}=`, `${name}=abc`, `${name}=.abc`, `${name}=123`, "other=1"]) {
      expect((await call("/api/config", { cookie: junk })).status).toBe(401);
    }
    expect((await call("/api/config", { cookie })).status).toBe(200);
  });

  it("signs out by clearing the cookie", async () => {
    const res = await call("/api/logout", { method: "POST" });
    expect(res.headers.get("set-cookie")).toContain("__Host-tm_session=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0");
  });

  it("changing the password signs every other device out", async () => {
    const cookie = await signIn("correct horse battery");
    const ip = freshIp();

    const wrong = await call("/api/password", { cookie, ip, json: { currentPassword: "nope", newPassword: "brand new password" } });
    expect(wrong.status).toBe(401);

    const short = await call("/api/password", { cookie, ip, json: { currentPassword: "correct horse battery", newPassword: "tiny" } });
    expect(short.status).toBe(400);

    const changed = await call("/api/password", { cookie, ip, json: { currentPassword: "correct horse battery", newPassword: "brand new password" } });
    expect(changed.status).toBe(200);
    const newCookie = cookieFrom(changed);

    expect((await call("/api/config", { cookie })).status).toBe(401); // old session is dead
    expect((await call("/api/config", { cookie: newCookie })).status).toBe(200); // the device that changed it stays in

    expect((await call("/api/login", { json: { password: "correct horse battery" }, ip: freshIp() })).status).toBe(401);
    expect((await call("/api/login", { json: { password: "brand new password" }, ip: freshIp() })).status).toBe(200);
  });
});

describe("AUTH_PASSWORD secret", () => {
  const withSecret = { env: { AUTH_PASSWORD: "from-the-dashboard" } };

  it("wins over the setup flow", async () => {
    const status = await json(await call("/api/status", withSecret));
    expect(status.setupRequired).toBe(false);
    expect(status.passwordSource).toBe("env");
    expect((await call("/api/setup", { ...withSecret, json: { password: "something else" } })).status).toBe(409);
  });

  it("signs in with the secret and refuses in-app password changes", async () => {
    const res = await call("/api/login", { ...withSecret, json: { password: "from-the-dashboard" }, ip: freshIp() });
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res);
    expect((await call("/api/config", { ...withSecret, cookie })).status).toBe(200);
    // The same cookie is worthless once the secret changes.
    expect((await call("/api/config", { cookie, env: { AUTH_PASSWORD: "rotated" } })).status).toBe(401);

    const change = await call("/api/password", { ...withSecret, cookie, json: { currentPassword: "from-the-dashboard", newPassword: "new one here" } });
    expect(change.status).toBe(400);
  });
});

describe("request hygiene", () => {
  it("refuses cross-site writes even with a valid cookie", async () => {
    const cookie = await signIn();
    const res = await call("/api/read-all", { method: "POST", cookie, headers: { "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
    expect((await call("/api/config", { cookie, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(200);
  });

  it("stamps security headers on API responses", async () => {
    const res = await call("/api/status");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("requires a session for everything else under /api", async () => {
    await signIn();
    for (const path of ["/api/config", "/api/messages", "/api/addresses", "/api/messages/x"]) {
      expect((await call(path)).status).toBe(401);
    }
    expect((await call("/api/nope", { cookie: await loginCookie() })).status).toBe(404);
  });
});

async function loginCookie(): Promise<string> {
  return cookieFrom(await call("/api/login", { json: { password: "correct horse battery" }, ip: freshIp() }));
}

describe("cross-site writes", () => {
  it("refuses a same-site write and any foreign Origin", async () => {
    const cookie = await signIn();
    // The session cookie is SameSite=Lax, so a sibling subdomain still sends it.
    for (const headers of [
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example.test" },
      { "sec-fetch-site": "same-origin", origin: "https://evil.example.test" },
    ]) {
      const res = await call("/api/read-all", { method: "POST", cookie, headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
  });

  it("still allows the app's own requests", async () => {
    const cookie = await signIn();
    for (const headers of [
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" },
      { "sec-fetch-site": "same-origin", origin: ORIGIN },
      {},                                   // a client that sends neither header
    ]) {
      const res = await call("/api/read-all", { method: "POST", cookie, headers });
      expect(res.status, JSON.stringify(headers)).toBe(200);
    }
  });
});
