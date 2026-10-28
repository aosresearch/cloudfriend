// Which client a sign-in attempt comes from, for the per-address login limit. Behind a reverse
// proxy every request arrives from the proxy, so keying the limit on the TCP peer would make it
// global: anyone could lock everyone out. CLOUDFRIEND_TRUSTED_PROXIES names the proxies whose
// X-Forwarded-For is believed; without it, a loopback or private peer is not taken as a client's
// own address (it is likely a proxy, or Docker's gateway that every client shares), and only the
// per-email limit applies to it.
import net from "node:net";
import { isPublicAddress } from "../net/outbound.ts";

/** Parsed CLOUDFRIEND_TRUSTED_PROXIES. */
export interface TrustedProxies {
  /** The setting as written, for logs. */
  spec: string;
  list: net.BlockList;
}

export class TrustedProxiesError extends Error {}

const KEYWORDS: Record<string, [string, number, "ipv4" | "ipv6"][]> = {
  loopback: [["127.0.0.0", 8, "ipv4"], ["::1", 128, "ipv6"]],
  private: [
    ["10.0.0.0", 8, "ipv4"],
    ["172.16.0.0", 12, "ipv4"],
    ["192.168.0.0", 16, "ipv4"],
    ["100.64.0.0", 10, "ipv4"],
    ["169.254.0.0", 16, "ipv4"],
    ["fc00::", 7, "ipv6"],
    ["fe80::", 10, "ipv6"],
  ],
};

/** `::ffff:10.0.0.1` (how Node reports IPv4 peers on a dual-stack socket) → `10.0.0.1`. */
function plain(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

const family = (ip: string): "ipv4" | "ipv6" | null => (net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : null);

/**
 * Parses a comma-separated list of IPs, CIDRs and the keywords `loopback` and `private`.
 * Empty or unset: null (no proxy is trusted). Throws TrustedProxiesError naming a bad entry.
 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxies | null {
  const entries = (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!entries.length) return null;
  const list = new net.BlockList();
  for (const entry of entries) {
    const ranges = KEYWORDS[entry];
    if (ranges) {
      for (const [address, prefix, type] of ranges) list.addSubnet(address, prefix, type);
      continue;
    }
    const [addr, bits, extra] = entry.split("/");
    const ip = plain(addr ?? "");
    const type = family(ip);
    const max = type === "ipv4" ? 32 : 128;
    const prefix = bits === undefined ? max : Number(bits);
    if (!type || extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > max || (bits !== undefined && !/^\d+$/.test(bits))) {
      throw new TrustedProxiesError(`CLOUDFRIEND_TRUSTED_PROXIES: ${JSON.stringify(entry)} is not an IP address, a CIDR, "loopback" or "private"`);
    }
    list.addSubnet(ip, prefix, type);
  }
  return { spec: entries.join(","), list };
}

function trusted(proxies: TrustedProxies, ip: string): boolean {
  const type = family(ip);
  return type !== null && proxies.list.check(ip, type);
}

/**
 * The client's own address, or null when there is none to key a limit on.
 * - With trusted proxies: a peer that isn't one is the client. From a trusted peer, X-Forwarded-For is
 *   read right to left, skipping trusted hops; the first other address is the client (the hops left of it
 *   were written by the client and can be forged). No usable header: null.
 * - Without: a public peer is the client; a loopback or private one is null (see the top of this file).
 */
export function clientAddress(peer: string | undefined, forwardedFor: string | undefined, proxies: TrustedProxies | null): string | null {
  if (!peer) return null;
  const ip = plain(peer);
  if (!proxies) return isPublicAddress(ip) ? ip : null;
  if (!trusted(proxies, ip)) return ip;
  const hops = (forwardedFor ?? "").split(",").map((s) => plain(s.trim())).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    if (!family(hop)) return null; // only a trusted proxy wrote this far; it wrote something we can't read
    if (!trusted(proxies, hop) || i === 0) return hop;
  }
  return null;
}
