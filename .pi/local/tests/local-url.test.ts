import assert from "node:assert/strict";
import test from "node:test";
import {
	assertLocalAddresses,
	pickLocalAddresses,
	pinLookup,
	isLocalIp,
	localApiUrl,
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
