/**
 * Signing in with a passkey.
 *
 * Driven with a real ECDSA key rather than fixtures, so the whole chain is
 * exercised: SPKI import, the DER signature an authenticator actually produces,
 * the rpId hash, the counter and the challenge.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { call, cookieFrom, freshDatabase, freshIp, json, signIn } from "./helpers";
import { derToRawSignature } from "../src/webauthn";

const ORIGIN = "https://mail.example.test";
const RP_ID = "mail.example.test";
const encoder = new TextEncoder();

let cookie: string;
beforeEach(async () => {
  await freshDatabase();
  cookie = await signIn();
});

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** WebCrypto signs raw r||s; an authenticator sends ASN.1 DER. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (value: Uint8Array): number[] => {
    let i = 0;
    while (i < value.length - 1 && value[i] === 0) i++;
    const trimmed = [...value.subarray(i)];
    if (trimmed[0] & 0x80) trimmed.unshift(0);
    return [0x02, trimmed.length, ...trimmed];
  };
  const body = [...integer(raw.subarray(0, 32)), ...integer(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

async function makeAuthenticator() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(RP_ID)));

  const authData = (options: { counter: number; rp?: string; flags?: number } ) => {
    const hash = options.rp
      ? new Uint8Array(32) // a different site's hash, filled below
      : rpHash;
    const bytes = new Uint8Array(37);
    bytes.set(hash, 0);
    bytes[32] = options.flags ?? 0x05; // user present + user verified
    new DataView(bytes.buffer).setUint32(33, options.counter);
    return bytes;
  };

  const clientData = (type: string, challenge: string, origin = ORIGIN) =>
    encoder.encode(JSON.stringify({ type, challenge: b64url(encoder.encode(challenge)), origin, crossOrigin: false }));

  const sign = async (authenticatorData: Uint8Array, clientDataJSON: Uint8Array) => {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
    const signed = new Uint8Array(authenticatorData.length + hash.length);
    signed.set(authenticatorData, 0);
    signed.set(hash, authenticatorData.length);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed));
    return rawToDer(raw);
  };

  return { spki, authData, clientData, sign, id: b64url(crypto.getRandomValues(new Uint8Array(16))) };
}

async function register(auth: Awaited<ReturnType<typeof makeAuthenticator>>) {
  const options = await json(await call("/api/passkeys/options", { cookie, method: "POST", json: {} }));
  const res = await call("/api/passkeys", {
    cookie,
    json: {
      id: auth.id,
      challenge: options.challenge,
      publicKey: b64url(auth.spki),
      alg: -7,
      clientDataJSON: b64url(auth.clientData("webauthn.create", options.challenge)),
      name: "Test key",
    },
  });
  return { res, options };
}

async function assertLogin(auth: Awaited<ReturnType<typeof makeAuthenticator>>, tweak: {
  counter?: number; origin?: string; challenge?: string; flags?: number; tamper?: boolean; id?: string;
} = {}) {
  const options = await json(await call("/api/webauthn/login/options", { method: "POST", json: {} }));
  const challenge = tweak.challenge ?? options.challenge;
  const authenticatorData = auth.authData({ counter: tweak.counter ?? 1, flags: tweak.flags });
  const clientDataJSON = auth.clientData("webauthn.get", challenge, tweak.origin);
  const signature = await auth.sign(authenticatorData, clientDataJSON);
  if (tweak.tamper) authenticatorData[35] ^= 0xff;   // after signing, so it no longer matches
  return call("/api/webauthn/login", {
    ip: freshIp(),
    json: {
      id: tweak.id ?? auth.id,
      challenge,
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authenticatorData),
      signature: b64url(signature),
    },
  });
}

describe("passkey signature handling", () => {
  it("turns a DER signature into the raw pair WebCrypto verifies", () => {
    const raw = crypto.getRandomValues(new Uint8Array(64));
    const back = derToRawSignature(rawToDer(raw));
    expect(back).not.toBeNull();
    expect([...back!]).toEqual([...raw]);
  });

  it("pads a short integer back up to 32 bytes", () => {
    const raw = crypto.getRandomValues(new Uint8Array(64));
    raw[0] = 0; raw[1] = 0; raw[32] = 0;   // leading zeros DER would drop
    expect([...derToRawSignature(rawToDer(raw))!]).toEqual([...raw]);
  });

  it("refuses anything that is not a DER sequence", () => {
    expect(derToRawSignature(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(derToRawSignature(new Uint8Array(0))).toBeNull();
  });
});

describe("passkeys", () => {
  it("is not offered until one is registered", async () => {
    expect((await json(await call("/api/status"))).passkeys).toBe(0);
    expect((await call("/api/webauthn/login/options", { method: "POST", json: {} })).status).toBe(404);
  });

  it("registers one and signs in with it", async () => {
    const auth = await makeAuthenticator();
    const { res } = await register(auth);
    expect(res.status).toBe(200);
    expect((await json(res)).passkeys).toHaveLength(1);
    expect((await json(await call("/api/status"))).passkeys).toBe(1);

    const login = await assertLogin(auth);
    expect(login.status).toBe(200);
    const session = cookieFrom(login);
    expect(session).toContain("tm_session");
    // And the session it hands back is a real one.
    expect((await json(await call("/api/status", { headers: { cookie: session } }))).authed).toBe(true);
  });

  it("remembers when it was last used", async () => {
    const auth = await makeAuthenticator();
    await register(auth);
    await assertLogin(auth);
    const [key] = (await json(await call("/api/passkeys", { cookie }))).passkeys;
    expect(key.lastUsedAt).toBeGreaterThan(0);
  });

  it("refuses a challenge it did not issue, or one already used", async () => {
    const auth = await makeAuthenticator();
    await register(auth);
    // A forged ticket never reaches the signature check.
    expect((await assertLogin(auth, { challenge: "passkey-login.deadbeef.99999999999.aaaa" })).status).toBe(400);

    // The real challenge is single use.
    const options = await json(await call("/api/webauthn/login/options", { method: "POST", json: {} }));
    const once = async () => {
      const authenticatorData = auth.authData({ counter: 2 });
      const clientDataJSON = auth.clientData("webauthn.get", options.challenge);
      return call("/api/webauthn/login", {
        ip: freshIp(),
        json: {
          id: auth.id, challenge: options.challenge,
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authenticatorData),
          signature: b64url(await auth.sign(authenticatorData, clientDataJSON)),
        },
      });
    };
    expect((await once()).status).toBe(200);
    expect((await once()).status).toBe(400);
  });

  it("refuses an assertion signed over a different challenge", async () => {
    const auth = await makeAuthenticator();
    await register(auth);
    // A real, current ticket in the body, but the authenticator was shown
    // something else -- which is what a relayed assertion looks like.
    const options = await json(await call("/api/webauthn/login/options", { method: "POST", json: {} }));
    const other = await json(await call("/api/webauthn/login/options", { method: "POST", json: {} }));
    const authenticatorData = auth.authData({ counter: 9 });
    const clientDataJSON = auth.clientData("webauthn.get", other.challenge);
    const res = await call("/api/webauthn/login", {
      ip: freshIp(),
      json: {
        id: auth.id, challenge: options.challenge,
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(await auth.sign(authenticatorData, clientDataJSON)),
      },
    });
    expect(res.status).toBe(401);
  });

  it("refuses a passkey used on another site", async () => {
    const auth = await makeAuthenticator();
    await register(auth);
    expect((await assertLogin(auth, { origin: "https://evil.example" })).status).toBe(401);
  });

  it("refuses a tampered assertion", async () => {
    const auth = await makeAuthenticator();
    await register(auth);
    expect((await assertLogin(auth, { tamper: true })).status).toBe(401);
  });

  it("refuses one nobody was present for", async () => {
    const auth = await makeAuthenticator();
    await register(auth);
    expect((await assertLogin(auth, { flags: 0x00 })).status).toBe(401);
  });

  it("refuses a credential it has never seen", async () => {
    const auth = await makeAuthenticator();
    await register(auth);
    expect((await assertLogin(auth, { id: "not-a-real-credential" })).status).toBe(401);
  });

  it("refuses a counter that has gone backwards", async () => {
    const auth = await makeAuthenticator();
    await register(auth);
    expect((await assertLogin(auth, { counter: 5 })).status).toBe(200);
    // A clone of the authenticator would replay an older count.
    expect((await assertLogin(auth, { counter: 3 })).status).toBe(401);
  });

  it("refuses an algorithm it cannot check", async () => {
    const auth = await makeAuthenticator();
    const options = await json(await call("/api/passkeys/options", { cookie, method: "POST", json: {} }));
    const res = await call("/api/passkeys", {
      cookie,
      json: {
        id: auth.id, challenge: options.challenge, publicKey: b64url(auth.spki), alg: -257,
        clientDataJSON: b64url(auth.clientData("webauthn.create", options.challenge)),
      },
    });
    expect(res.status).toBe(400);
  });

  it("removes one, and the password still works", async () => {
    const auth = await makeAuthenticator();
    await register(auth);
    const left = await json(await call(`/api/passkeys/${encodeURIComponent(auth.id)}`, { cookie, method: "DELETE" }));
    expect(left.passkeys).toHaveLength(0);
    expect((await call("/api/webauthn/login/options", { method: "POST", json: {} })).status).toBe(404);
    // The recovery path is untouched: removing every passkey cannot lock anyone out.
    expect((await call("/api/login", { json: { password: "correct horse battery" } })).status).toBe(200);
  });

  it("needs a session to register one", async () => {
    expect((await call("/api/passkeys/options", { method: "POST", json: {} })).status).toBe(401);
    expect((await call("/api/passkeys", { json: {} })).status).toBe(401);
    expect((await call("/api/passkeys/x", { method: "DELETE" })).status).toBe(401);
  });
});
