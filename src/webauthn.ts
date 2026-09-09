/**
 * Signing in with a passkey.
 *
 * An addition to the password, never a replacement: the password stays the
 * recovery path, because a passkey lives on one device and a device can be
 * lost, and locking the owner out of their own inbox is the one failure this
 * feature must not have.
 *
 * Deliberately small. WebAuthn's reputation for complexity comes mostly from
 * attestation and from parsing COSE keys out of CBOR, and neither is needed
 * here: the browser has offered getPublicKey() since 2021, which hands over the
 * key already in SPKI -- exactly what WebCrypto imports. That removes a CBOR
 * parser, a COSE decoder, and every bug in them. Attestation is skipped
 * outright: it answers "what kind of authenticator is this", and a
 * single-person inbox has no policy that needs the answer.
 *
 * ES256 only, which every platform authenticator supports.
 */

const encoder = new TextEncoder();

/** The one algorithm this accepts: ECDSA over P-256 with SHA-256. */
export const ES256 = -7;
/** How long a ceremony has to finish. */
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;

export interface CredentialRow {
  id: string;
  public_key: string;
  sign_count: number;
  name: string | null;
  created_at: number;
  last_used_at: number | null;
}

/* --------------------------------------------------------------- base64 */

export function base64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ------------------------------------------------------------ signatures */

/**
 * An ECDSA signature from DER into the raw form WebCrypto verifies.
 *
 * Authenticators sign in ASN.1 DER -- SEQUENCE { r INTEGER, s INTEGER } --
 * and WebCrypto wants the two numbers concatenated, each padded to 32 bytes.
 * DER integers are signed, so a value whose top bit is set carries a leading
 * zero that has to come off, and a short one has to be padded back up.
 */
export function derToRawSignature(der: Uint8Array): Uint8Array | null {
  if (der[0] !== 0x30) return null;
  // Length may be one byte, or 0x81 followed by one byte. Nothing longer can
  // describe a P-256 signature.
  let offset = der[1] & 0x80 ? 3 : 2;
  const readInteger = (): Uint8Array | null => {
    if (der[offset++] !== 0x02) return null;
    const length = der[offset++];
    if (!length || offset + length > der.length) return null;
    let value = der.subarray(offset, offset + length);
    offset += length;
    while (value.length > 32 && value[0] === 0x00) value = value.subarray(1);
    if (value.length > 32) return null;
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  const r = readInteger();
  const s = readInteger();
  if (!r || !s) return null;
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/* ---------------------------------------------------- ceremony checking */

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

/**
 * Checks the browser's account of what it was asked to do.
 *
 * The challenge comparison is what stops a signature being reused, and the
 * origin comparison is what stops another site collecting one -- so both are
 * exact, and both are checked here rather than left to the caller.
 */
export function readClientData(json: Uint8Array, expected: { type: string; challenge: string; origin: string }): { ok: true; data: ClientData } | { ok: false; why: string } {
  let data: ClientData;
  try {
    data = JSON.parse(new TextDecoder().decode(json)) as ClientData;
  } catch {
    return { ok: false, why: "The browser sent something unreadable" };
  }
  if (data.type !== expected.type) return { ok: false, why: "That is not the ceremony we asked for" };
  if (data.origin !== expected.origin) return { ok: false, why: "That passkey was used on a different site" };
  if (data.crossOrigin) return { ok: false, why: "That passkey was used from inside another page" };
  if (data.challenge !== expected.challenge) return { ok: false, why: "That sign-in has already been used or has expired" };
  return { ok: true, data };
}

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
}

export function readAuthenticatorData(bytes: Uint8Array): AuthenticatorData | null {
  if (bytes.length < 37) return null;
  const flags = bytes[32];
  const view = new DataView(bytes.buffer, bytes.byteOffset + 33, 4);
  return {
    rpIdHash: bytes.subarray(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount: view.getUint32(0),
  };
}

export async function rpIdHash(rpId: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(rpId)));
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}

/**
 * Verifies one assertion.
 *
 * The authenticator signs the authenticator data followed by a hash of the
 * client data, so both are covered: change either and the signature stops
 * matching.
 */
export async function verifyAssertion(options: {
  publicKeySpki: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}): Promise<boolean> {
  const raw = derToRawSignature(options.signature);
  if (!raw) return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "spki",
      options.publicKeySpki as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
  } catch {
    return false;
  }
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", options.clientDataJSON as BufferSource));
  const signed = new Uint8Array(options.authenticatorData.length + clientHash.length);
  signed.set(options.authenticatorData, 0);
  signed.set(clientHash, options.authenticatorData.length);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw as BufferSource, signed as BufferSource);
}

/**
 * Whether a counter has gone backwards, which is how a cloned authenticator
 * gives itself away.
 *
 * Only meaningful once it has been above zero: plenty of authenticators,
 * including Apple's, never increment it at all, and refusing those would lock
 * out the most common passkey there is.
 */
export function counterLooksCloned(stored: number, offered: number): boolean {
  if (stored === 0 && offered === 0) return false;
  return offered <= stored;
}
