import assert from "node:assert/strict";
import test from "node:test";
import {
	assertLocalAddresses,
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

test("assertLocalAddresses rejects mixed or public DNS results", () => {
	assert.doesNotThrow(() => assertLocalAddresses("paperless.example.local", ["192.168.1.10"]));
	assert.throws(
		() => assertLocalAddresses("paperless.example.local", ["192.168.1.10", "8.8.8.8"]),
		UnsafeUrlError,
	);
	assert.throws(() => assertLocalAddresses("paperless.example.local", []), UnsafeUrlError);
});
