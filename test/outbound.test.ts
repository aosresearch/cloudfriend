import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { checkDestinationUrl, isPublicAddress, outboundFetch, OutboundError, allowPrivateDestinations, type Resolver } from "../src/net/outbound.ts";

const PUBLIC_V4 = "93.184.215.14";
const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c";

/** A resolver that answers from a table and counts calls. Unknown names fail like NXDOMAIN. */
function stubResolver(table: Record<string, string[] | ((n: number) => string[])>) {
  const calls: string[] = [];
  const resolve: Resolver = async (host) => {
    calls.push(host);
    const entry = table[host];
    if (!entry) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    const addrs = typeof entry === "function" ? entry(calls.filter((h) => h === host).length) : entry;
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { resolve, calls };
}

/** A local HTTP server; `handler` gets every request. */
async function server(handler: http.RequestListener) {
  const requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      handler(req, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))),
  };
}

describe("isPublicAddress", () => {
  const blocked = [
    // IPv4
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.255.254",
    "169.254.169.254", "169.254.170.2", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.170", "192.0.2.1",
    "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1",
    "239.255.255.250", "240.0.0.1", "255.255.255.255",
    // IPv6
    "::", "::1", "fe80::1", "fe80::1%en0", "febf::1", "fc00::1", "fd12:3456:789a::1", "ff02::1", "fec0::1", "100::1",
    "2001:db8::1", "2001::1", "2001:2::1", "3fff::1",
    // IPv4-mapped, IPv4-compatible, NAT64 and 6to4 forms of private addresses
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "0:0:0:0:0:ffff:a00:1",
    "::10.0.0.1", "::8.8.8.8", "64:ff9b::10.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::8.8.8.8", "2002:a00:1::1", "2002:7f00:1::",
    // not an IP at all
    "", "localhost", "example.com", "1.2.3", "010.0.0.1",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", PUBLIC_V4, "172.32.0.1", "100.128.0.1", "192.169.0.1", "11.0.0.1", PUBLIC_V6,
    "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8", "2002:808:808::1"];

  for (const ip of blocked) it(`blocks ${ip || "(empty)"}`, () => assert.equal(isPublicAddress(ip), false));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(isPublicAddress(ip), true));
});

describe("allowPrivateDestinations", () => {
  it("accepts on, true, 1 and yes, in any case", () => {
    for (const v of ["on", "true", "1", "yes", "ON", " Yes "]) assert.equal(allowPrivateDestinations({ CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS: v }), true, v);
    for (const v of [undefined, "", "off", "0", "no", "false"]) assert.equal(allowPrivateDestinations({ CLOUDFRIEND_ALLOW_PRIVATE_DESTINATIONS: v }), false, String(v));
  });
});

describe("checkDestinationUrl", () => {
  const dns = stubResolver({
    "hooks.example.com": [PUBLIC_V4, PUBLIC_V6],
    "mixed.example.com": [PUBLIC_V4, "10.0.0.5"],
    "mixed6.example.com": [PUBLIC_V4, "fd00::5"],
    "mapped.example.com": ["::ffff:10.0.0.1"],
    "metadata.example.com": ["169.254.169.254"],
    "ecs.example.com": ["169.254.170.2"],
    "empty.example.com": [],
    "dev.example.com": ["127.0.0.1"],
  });
  const strict = { allowPrivate: false, resolve: dns.resolve };
  const lax = { allowPrivate: true, resolve: dns.resolve };
  const refused = async (url: string, error: string, opts = strict) => assert.deepEqual(await checkDestinationUrl(url, opts), { ok: false, error }, url);

  it("allows https to a host whose addresses are all public", async () => {
    assert.deepEqual(await checkDestinationUrl("https://hooks.example.com/a?b=c", strict), { ok: true });
    assert.deepEqual(await checkDestinationUrl(`https://${PUBLIC_V4}/x`, strict), { ok: true });
    assert.deepEqual(await checkDestinationUrl(`https://[${PUBLIC_V6}]/x`, strict), { ok: true });
  });

  it("needs https, and allows http only with allowPrivate", async () => {
    await refused("http://hooks.example.com/", "use an https URL");
    await refused("ftp://hooks.example.com/", "use an https URL");
    await refused("file:///etc/passwd", "use an https URL");
    await refused("gopher://hooks.example.com/", "use an http or https URL", lax);
    assert.deepEqual(await checkDestinationUrl("http://hooks.example.com/", lax), { ok: true });
  });

  it("refuses URLs that aren't URLs or carry credentials", async () => {
    await refused("not a url", "not a valid URL");
    await refused("", "not a valid URL");
    await refused("https://user:pass@hooks.example.com/", "remove the user name and password from the URL");
    await refused("https://user@hooks.example.com/", "remove the user name and password from the URL");
  });

  it("refuses private, loopback and link-local literals", async () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.10", "169.254.169.254", "169.254.170.2", "100.64.1.1", "0.0.0.0", "255.255.255.255", "224.0.0.1", "[::1]", "[::]", "[fe80::1]", "[fd00::1]", "[ff02::1]"]) {
      await refused(`https://${host}/`, "private address");
    }
  });

  it("refuses IPv4 literals in decimal, octal and hex, which URL parsing normalizes", async () => {
    for (const host of ["2130706433", "0x7f000001", "0x7f.1", "017700000001", "0177.0.0.1", "127.1", "0", "0xa9.0xfe.0xa9.0xfe", "3232235777"]) {
      const normalized = new URL(`https://${host}/`).hostname;
      assert.match(normalized, /^\d+\.\d+\.\d+\.\d+$/, `${host} parses as dotted decimal`);
      await refused(`https://${host}/`, "private address");
    }
    assert.equal(new URL("https://2130706433/").hostname, "127.0.0.1");
    assert.equal(new URL("https://0xa9.0xfe.0xa9.0xfe/").hostname, "169.254.169.254");
  });

  it("refuses IPv4-mapped, compatible and NAT64 IPv6 forms of private addresses", async () => {
    for (const host of ["[::ffff:127.0.0.1]", "[::ffff:10.0.0.1]", "[::ffff:a9fe:a9fe]", "[0:0:0:0:0:ffff:c0a8:1]", "[::127.0.0.1]", "[64:ff9b::10.0.0.1]", "[64:ff9b::a9fe:a9fe]"]) {
      await refused(`https://${host}/`, "private address");
    }
    assert.deepEqual(await checkDestinationUrl("https://[::ffff:8.8.8.8]/", strict), { ok: true });
  });

  it("refuses localhost by name without asking DNS", async () => {
    const before = dns.calls.length;
    for (const host of ["localhost", "LOCALHOST", "localhost.", "api.localhost"]) await refused(`https://${host}/`, "private address");
    assert.equal(dns.calls.length, before);
  });

  it("refuses a host if any of its addresses is private", async () => {
    await refused("https://mixed.example.com/", "private address");
    await refused("https://mixed6.example.com/", "private address");
    await refused("https://mapped.example.com/", "private address");
    await refused("https://metadata.example.com/latest/meta-data/", "private address");
    await refused("https://ecs.example.com/v2/credentials", "private address");
  });

  it("refuses hosts that don't resolve", async () => {
    await refused("https://nowhere.example.com/", "host not found");
    await refused("https://empty.example.com/", "host not found");
  });

  it("allows private addresses and http with allowPrivate", async () => {
    assert.deepEqual(await checkDestinationUrl("http://dev.example.com:8080/", lax), { ok: true });
    assert.deepEqual(await checkDestinationUrl("http://127.0.0.1:8080/", lax), { ok: true });
    assert.deepEqual(await checkDestinationUrl("http://[::1]:8080/", lax), { ok: true });
    assert.deepEqual(await checkDestinationUrl("https://mixed.example.com/", lax), { ok: true });
  });
});

describe("outboundFetch", () => {
  const lax = { allowPrivate: true };

  it("sends the request with user-agent cloudfriend and returns the status", async () => {
    const s = await server((_req, res) => res.writeHead(201).end("created"));
    try {
      const res = await outboundFetch(s.url + "/hook?x=1", { method: "POST", headers: { "content-type": "application/json", "user-agent": "spoof" }, body: '{"a":1}' }, lax);
      assert.equal(res.status, 201);
      assert.equal(res.ok, true);
      assert.equal(await res.text(), "created");
      const req = s.requests[0]!;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/hook?x=1");
      assert.equal(req.headers["user-agent"], "cloudfriend");
      assert.equal(req.headers["content-type"], "application/json");
      assert.equal(req.body, '{"a":1}');
    } finally {
      await s.close();
    }
  });

  it("connects only to the address its resolver checked", async () => {
    const s = await server((_req, res) => res.end("ok"));
    const dns = stubResolver({ "pinned.example": ["127.0.0.1"] });
    try {
      // pinned.example doesn't exist in real DNS: reaching the server proves the checked lookup was used.
      const res = await outboundFetch(`http://pinned.example:${s.port}/`, { method: "POST", body: "x" }, { allowPrivate: true, resolve: dns.resolve });
      assert.equal(res.status, 200);
      assert.equal(s.requests[0]!.headers.host, `pinned.example:${s.port}`);
      assert.deepEqual(dns.calls, ["pinned.example"]);
    } finally {
      await s.close();
    }
  });

  it("refuses at connect time when DNS changes to a private address after the check (rebinding)", async () => {
    const s = await server((_req, res) => res.end("ok"));
    // First answer public, every later one the local server.
    const dns = stubResolver({ "rebind.example": (n) => (n === 1 ? [PUBLIC_V4] : ["127.0.0.1"]) });
    try {
      const url = `https://rebind.example:${s.port}/`;
      assert.deepEqual(await checkDestinationUrl(url, { allowPrivate: false, resolve: dns.resolve }), { ok: true });
      await assert.rejects(outboundFetch(url, { method: "POST", body: "x" }, { allowPrivate: false, resolve: dns.resolve }), (err: unknown) => {
        assert.ok(err instanceof OutboundError);
        assert.equal(err.message, "destination refused: private address");
        assert.equal(err.kind, "refused");
        return true;
      });
      assert.equal(dns.calls.length, 2, "resolved again when connecting");
      assert.equal(s.requests.length, 0);
    } finally {
      await s.close();
    }
  });

  it("refuses at connect time when one of several addresses is private", async () => {
    const dns = stubResolver({ "mixed.example": [PUBLIC_V4, "10.0.0.1"] });
    await assert.rejects(outboundFetch("https://mixed.example/", { method: "POST" }, { allowPrivate: false, resolve: dns.resolve }), {
      message: "destination refused: private address",
    });
  });

  it("refuses private literals and http without touching the network", async () => {
    const dns = stubResolver({});
    for (const url of ["https://127.0.0.1/", "https://2130706433/", "https://[::ffff:127.0.0.1]/", "https://169.254.169.254/latest/meta-data/", "https://localhost/"]) {
      await assert.rejects(outboundFetch(url, {}, { allowPrivate: false, resolve: dns.resolve }), { message: "destination refused: private address" }, url);
    }
    await assert.rejects(outboundFetch("http://example.com/", {}, { allowPrivate: false, resolve: dns.resolve }), { message: "destination refused: use an https URL" });
    await assert.rejects(outboundFetch("https://a:b@example.com/", {}, { allowPrivate: false, resolve: dns.resolve }), { message: /destination refused: remove the user name/ });
    assert.deepEqual(dns.calls, []);
  });

  it("never follows redirects", async () => {
    const target = await server((_req, res) => res.end("secret internal page"));
    const s = await server((_req, res) => res.writeHead(302, { location: target.url + "/internal" }).end());
    try {
      const res = await outboundFetch(s.url, { method: "POST", body: "x" }, lax);
      assert.equal(res.status, 302);
      assert.equal(res.ok, false);
      assert.equal(target.requests.length, 0);
    } finally {
      await s.close();
      await target.close();
    }
  });

  it("times out", async () => {
    const s = await server(() => {}); // never replies
    try {
      const start = Date.now();
      await assert.rejects(outboundFetch(s.url, { method: "POST", body: "x" }, { allowPrivate: true, timeoutMs: 200 }), (err: unknown) => {
        assert.ok(err instanceof OutboundError);
        assert.equal(err.message, "timed out");
        return true;
      });
      assert.ok(Date.now() - start < 2000);
    } finally {
      await s.close();
    }
  });

  it("times out on a body that never ends", async () => {
    const s = await server((_req, res) => {
      res.writeHead(200);
      res.write("partial");
    });
    try {
      // The first chunk is below the cap and the body never ends: the timeout still applies.
      await assert.rejects(outboundFetch(s.url, {}, { allowPrivate: true, timeoutMs: 200 }), { message: "timed out" });
    } finally {
      await s.close();
    }
  });

  it("reports the caller's abort and a caller timeout", async () => {
    const s = await server(() => {});
    try {
      const ac = new AbortController();
      const p = outboundFetch(s.url, { signal: ac.signal }, lax);
      setTimeout(() => ac.abort(), 50);
      await assert.rejects(p, { message: "aborted" });
      await assert.rejects(outboundFetch(s.url, { signal: AbortSignal.timeout(50) }, lax), { message: "timed out" });
    } finally {
      await s.close();
    }
  });

  it("reads at most maxResponseBytes of the body and discards the rest", async () => {
    const s = await server((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      // 8 MB, written in chunks; the client should stop long before the end.
      let left = 128;
      const chunk = "x".repeat(64 * 1024);
      const write = () => {
        while (left > 0) {
          left--;
          if (!res.write(chunk)) return void res.once("drain", write);
        }
        res.end();
      };
      write();
    });
    try {
      const res = await outboundFetch(s.url, {}, lax);
      assert.equal(res.status, 200);
      assert.equal((await res.text()).length, 4096);
      const small = await outboundFetch(s.url, {}, { allowPrivate: true, maxResponseBytes: 10 });
      assert.equal(await small.text(), "xxxxxxxxxx");
    } finally {
      await s.close();
    }
  });

  it("gives short errors for connection failures", async () => {
    const s = await server(() => {});
    const port = s.port;
    await s.close();
    await assert.rejects(outboundFetch(`http://127.0.0.1:${port}/`, {}, lax), { message: "connection refused" });
    const dns = stubResolver({});
    await assert.rejects(outboundFetch("https://nowhere.example/", {}, { allowPrivate: false, resolve: dns.resolve }), { message: "host not found" });
  });

  it("returns a non-2xx status without putting the body in any error", async () => {
    const s = await server((_req, res) => res.writeHead(500).end("db password: hunter2"));
    try {
      const res = await outboundFetch(s.url, { method: "POST", body: "x" }, lax);
      assert.equal(res.status, 500);
      assert.equal(res.ok, false);
    } finally {
      await s.close();
    }
  });
});
