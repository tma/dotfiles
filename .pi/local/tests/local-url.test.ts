import assert from "node:assert/strict";
import test from "node:test";
import {
	assertLocalAddresses,
	pickLocalAddresses,
	pinLookup,
	isLocalIp,
	localApiUrl,
	parseLocalIpOrigin,
	parseLocalOrigin,
	UnsafeUrlError,
} from "../extensions/lib/local-url.ts";

test("isLocalIp allows RFC1918, loopback, Tailscale, and ULA", () => {
	assert.equal(isLocalIp("10.0.0.5"), true);
	assert.equal(isLocalIp("127.0.0.1"), true);
	assert.equal(isLocalIp("192.168.1.10"), true);
	assert.equal(isLocalIp("172.16.4.1"), true);
	assert.equal(isLocalIp("100.64.1.2"), true);
	assert.equal(isLocalIp("::1"), true);
	assert.equal(isLocalIp("fd12:3456:789a::1"), true);
});

test("isLocalIp rejects public, metadata, and unspecified addresses", () => {
	assert.equal(isLocalIp("8.8.8.8"), false);
	assert.equal(isLocalIp("1.1.1.1"), false);
	assert.equal(isLocalIp("169.254.169.254"), false);
	assert.equal(isLocalIp("0.0.0.0"), false);
	assert.equal(isLocalIp("224.0.0.1"), false);
	assert.equal(isLocalIp("2001:4860:4860::8888"), false);
});

test("isLocalIp handles IPv6 by prefix, not by string shape", () => {
	assert.equal(isLocalIp("[fd12::1]"), true);
	assert.equal(isLocalIp("::ffff:127.0.0.1"), true);
	assert.equal(isLocalIp("::ffff:7f00:1"), true);
	assert.equal(isLocalIp("::ffff:c0a8:10a"), true);
	assert.equal(isLocalIp("::ffff:8.8.8.8"), false);
	assert.equal(isLocalIp("fd::1"), false);
	assert.equal(isLocalIp("fe80::1"), false);
	assert.equal(isLocalIp("::"), false);
});

test("parseLocalIpOrigin accepts only local IP literals", () => {
	assert.deepEqual(parseLocalIpOrigin("http://127.0.0.1:1234", "LM_STUDIO_URL"), {
		origin: "http://127.0.0.1:1234",
		pathPrefix: "",
		hostname: "127.0.0.1",
	});
	assert.equal(parseLocalIpOrigin("http://[::1]:1234/v1").origin, "http://[::1]:1234");
	assert.equal(parseLocalIpOrigin("http://[fd12::1]:1234").hostname, "fd12::1");
	assert.equal(parseLocalIpOrigin("http://192.168.1.10:1234").hostname, "192.168.1.10");
	assert.throws(() => parseLocalIpOrigin("http://localhost:1234"), /IP address/);
	assert.throws(() => parseLocalIpOrigin("http://lmstudio.example.local:1234"), /IP address/);
	assert.throws(() => parseLocalIpOrigin("http://8.8.8.8:1234"), UnsafeUrlError);
	assert.throws(() => parseLocalIpOrigin("http://[2001:4860:4860::8888]:1234"), UnsafeUrlError);
});

test("parseLocalOrigin accepts local http(s) origins and path prefixes", () => {
	assert.deepEqual(parseLocalOrigin("http://192.168.1.10:8000"), {
		origin: "http://192.168.1.10:8000",
		pathPrefix: "",
		hostname: "192.168.1.10",
	});
	assert.deepEqual(parseLocalOrigin("http://paperless.example.local:8000/paperless/"), {
		origin: "http://paperless.example.local:8000",
		pathPrefix: "/paperless",
		hostname: "paperless.example.local",
	});
	assert.equal(parseLocalOrigin("http://localhost:8000").hostname, "localhost");
});

test("parseLocalOrigin rejects credentials, public IPs, and non-http", () => {
	assert.throws(() => parseLocalOrigin("http://user:token@192.168.1.10:8000"), UnsafeUrlError);
	assert.throws(() => parseLocalOrigin("http://8.8.8.8:8000"), UnsafeUrlError);
	assert.throws(() => parseLocalOrigin("http://169.254.169.254/"), UnsafeUrlError);
	assert.throws(() => parseLocalOrigin("ftp://192.168.1.10:8000"), UnsafeUrlError);
	assert.throws(() => parseLocalOrigin("not a url"), UnsafeUrlError);
});

test("localApiUrl stays on the configured origin and prefix", () => {
	const base = parseLocalOrigin("http://10.0.0.5:8000/paperless");
	const url = localApiUrl(base, "/api/documents/?query=tax");
	assert.equal(url.toString(), "http://10.0.0.5:8000/paperless/api/documents/?query=tax");
});

test("pickLocalAddresses keeps local IPs behind a domain and drops public ones", () => {
	assert.deepEqual(pickLocalAddresses("paperless.example.com", ["192.168.1.10"]), ["192.168.1.10"]);
	assert.deepEqual(pickLocalAddresses("paperless.example.com", ["8.8.8.8", "10.0.0.5"]), ["10.0.0.5"]);
	assert.throws(() => pickLocalAddresses("paperless.example.com", ["8.8.8.8"]), UnsafeUrlError);
	assert.throws(() => pickLocalAddresses("paperless.example.com", []), UnsafeUrlError);
	assert.deepEqual(assertLocalAddresses("paperless.example.local", ["192.168.1.10"]), ["192.168.1.10"]);
});

test("fetchLocal pins loopback and preserves Host", async () => {
	const { createServer } = await import("node:http");
	const { fetchLocal } = await import("../extensions/lib/local-url.ts");
	const seen: string[] = [];
	const server = createServer((req, res) => {
		seen.push(req.headers.host ?? "");
		res.end("ok");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	try {
		const res = await fetchLocal(new URL(`http://127.0.0.1:${address.port}/`));
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "ok");
		assert.equal(seen[0], `127.0.0.1:${address.port}`);
	} finally {
		server.close();
	}
});

test("pinLookup returns an address list when options.all is set", () => {
	let allResult: unknown;
	pinLookup("127.0.0.1", 4, { all: true }, (_err, address) => {
		allResult = address;
	});
	assert.deepEqual(allResult, [{ address: "127.0.0.1", family: 4 }]);

	let single: unknown;
	let family: unknown;
	pinLookup("10.0.0.5", 4, {}, (_err, address, fam) => {
		single = address;
		family = fam;
	});
	assert.equal(single, "10.0.0.5");
	assert.equal(family, 4);
});
