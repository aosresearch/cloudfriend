import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Stored format: scrypt$<log2 N>$<r>$<p>$<salt base64url>$<hash base64url>
// The parameters travel with the hash, so they can be raised later; needsRehash() tells when.

export interface ScryptParams {
  /** log2 of the CPU/memory cost N. */
  logN: number;
  r: number;
  p: number;
}

/**
 * N = 2^15, r = 8, p = 1: 32 MiB per hash. Node runs scrypt on the libuv pool (4 threads by default), so peak
 * memory under a login flood is about 128 MiB, which a small self-hosted container can take. OWASP suggests
 * N = 2^17 (128 MiB per hash); raise logN here if the host has the memory, and old hashes are upgraded on the
 * next successful login (needsRehash).
 */
export const DEFAULT_SCRYPT: ScryptParams = { logN: 15, r: 8, p: 1 };

const KEY_LEN = 32;
const SALT_LEN = 16;
// Refuse absurd parameters from a corrupted or hostile stored hash instead of burning CPU/RAM on them.
const MAX_LOG_N = 20;
const MAX_R = 32;
const MAX_P = 16;

function derive(password: string, salt: Buffer, { logN, r, p }: ScryptParams): Promise<Buffer> {
  const N = 2 ** logN;
  const opts: ScryptOptions = { N, r, p, maxmem: 128 * N * r * p + 16 * 1024 * 1024 };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFC"), salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, params);
  return ["scrypt", params.logN, params.r, params.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

function parse(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [logN, r, p] = parts.slice(1, 4).map((x) => (/^\d{1,3}$/.test(x!) ? Number(x) : NaN)) as [number, number, number];
  if (!(logN >= 1 && logN <= MAX_LOG_N && r >= 1 && r <= MAX_R && p >= 1 && p <= MAX_P)) return null;
  const salt = Buffer.from(parts[4]!, "base64url");
  const key = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 8 || key.length < 16) return null;
  return { params: { logN, r, p }, salt, key };
}

/** Constant-time check of a password against a stored hash. False for malformed hashes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.params);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

/** True when the stored hash uses weaker parameters than `params` (rehash it after a successful login). */
export function needsRehash(stored: string, params: ScryptParams = DEFAULT_SCRYPT): boolean {
  const parsed = parse(stored);
  if (!parsed) return true;
  const { logN, r, p } = parsed.params;
  return logN < params.logN || r < params.r || p < params.p || parsed.key.length < KEY_LEN;
}

/** A random password with 192 bits of entropy (32 base64url characters). */
export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

let dummy: Promise<string> | null = null;

/** Spend the same time as a real check, so a login for an unknown email can't be told apart by timing. */
export async function burnPasswordCheck(password: string): Promise<false> {
  dummy ??= hashPassword(generatePassword());
  await verifyPassword(password, await dummy);
  return false;
}
