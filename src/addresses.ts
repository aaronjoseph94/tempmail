/**
 * Addresses as first-class things.
 *
 * The inbox is a catch-all, so an address exists the moment mail arrives for
 * it. This module adds a lifecycle on top: an address can be permanent, can
 * expire, or can be blocked. Mail to a dead address is refused at SMTP time,
 * so it never lands and the sender gets a bounce.
 *
 * Each address also remembers the first domain that wrote to it. That is the
 * service the address was handed to; mail from anyone else means the address
 * leaked, and the leak view shows who has it.
 */

export const ADDRESS_MODES = ["permanent", "expires", "blocked"] as const;
export type AddressMode = (typeof ADDRESS_MODES)[number];

export interface AddressRow {
  address: string;
  label: string | null;
  mode: AddressMode;
  expires_at: number | null;
  owner_domain: string | null;
  created_at: number;
  first_seen_at: number | null;
}

export type Verdict = { accept: true; row: AddressRow | null } | { accept: false; reason: string };

/** Whether mail for this address should be stored, judged before any parsing. */
export async function addressVerdict(db: D1Database, address: string, now: number): Promise<Verdict> {
  const row = await db.prepare("SELECT * FROM addresses WHERE address = ?1").bind(address).first<AddressRow>();
  if (!row) return { accept: true, row: null };
  if (isDead(row, now)) {
    // The same reason for every case: senders learn nothing about why.
    return { accept: false, reason: "No such mailbox" };
  }
  return { accept: true, row };
}

/** True when the lifecycle says this address takes no more mail. */
export function isDead(row: AddressRow, now: number): boolean {
  switch (row.mode) {
    case "blocked": return true;
    case "expires": return row.expires_at != null && row.expires_at <= now;
    default: return false;
  }
}

/**
 * Notes that mail arrived. Unknown addresses get a permanent row (this is
 * what keeps the catch-all working); existing rows learn their first sender
 * and first arrival only if they had none.
 */
export async function recordArrival(db: D1Database, address: string, senderDomain: string | null, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO addresses (address, mode, created_at, first_seen_at, owner_domain)
       VALUES (?1, 'permanent', ?2, ?2, ?3)
       ON CONFLICT(address) DO UPDATE SET
         first_seen_at = COALESCE(addresses.first_seen_at, excluded.first_seen_at),
         owner_domain  = COALESCE(addresses.owner_domain, excluded.owner_domain)`
    )
    .bind(address, now, senderDomain)
    .run();
}

/** "mail.github.com" belongs to "github.com"; "github.com.evil.net" does not. */
export function relatedDomain(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x === y || x.endsWith("." + y) || y.endsWith("." + x);
}

export function senderDomain(fromAddress: string | null | undefined): string | null {
  if (!fromAddress) return null;
  const at = fromAddress.lastIndexOf("@");
  if (at < 0 || at === fromAddress.length - 1) return null;
  return fromAddress.slice(at + 1).toLowerCase();
}

export function isAddressMode(value: unknown): value is AddressMode {
  return typeof value === "string" && (ADDRESS_MODES as readonly string[]).includes(value);
}
