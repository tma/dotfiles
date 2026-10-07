/**
 * Public-web URL policy and a pinned HTTP(S) client for web_read and the
 * public search providers.
 *
 * Each hop is validated, resolved once, and connected to the vetted address
 * through request.lookup, so DNS cannot change between the check and the
 * connection. Requests use Node's http/https directly, which also bypasses
 * any fetch dispatcher or proxy Pi installs globally.
 */

import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import zlib from "node:zlib";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
	"broadcasthost",
	"host.docker.internal",
]);

// IPv4 ranges that are not globally reachable. BlockList also matches these
// in IPv4-mapped IPv6 form (::ffff:127.0.0.1, ::ffff:7f00:1).
const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
	["0.0.0.0", 8], // current network
	["10.0.0.0", 8], // RFC1918
	["100.64.0.0", 10], // carrier-grade NAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local, cloud metadata
	["172.16.0.0", 12], // RFC1918
	["192.0.0.0", 24], // IETF protocol assignments
	["192.0.2.0", 24], // documentation
	["192.88.99.0", 24], // deprecated 6to4 relay anycast
	["192.168.0.0", 16], // RFC1918
	["198.18.0.0", 15], // benchmarking
	["198.51.100.0", 24], // documentation
	["203.0.113.0", 24], // documentation
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved, broadcast
];

const BLOCKED_IPV4 = new BlockList();
for (const [network, prefix] of BLOCKED_IPV4_CIDRS) BLOCKED_IPV4.addSubnet(network, prefix, "ipv4");

// IPv6 is allowed only in global unicast, IPv4-mapped, or well-known NAT64
// space. Everything else (::, ::1, fc00::/7, fe80::/10, ff00::/8, the
// 64:ff9b:1::/48 local NAT64 prefix, ...) is blocked.
const PUBLIC_IPV6 = new BlockList();
PUBLIC_IPV6.addSubnet("2000::", 3, "ipv6");
PUBLIC_IPV6.addSubnet("::ffff:0:0", 96, "ipv6");
PUBLIC_IPV6.addSubnet("64:ff9b::", 96, "ipv6");

// Non-global parts of 2000::/3, plus NAT64 translations of blocked IPv4.
// 2001::/23 is conservative: it covers Teredo and ORCHID along with a few
// global anycast services. 6to4 is blocked rather than decoded.
const BLOCKED_IPV6 = new BlockList();
BLOCKED_IPV6.addSubnet("2001::", 23, "ipv6");
BLOCKED_IPV6.addSubnet("2001:db8::", 32, "ipv6"); // documentation
BLOCKED_IPV6.addSubnet("2002::", 16, "ipv6"); // 6to4
BLOCKED_IPV6.addSubnet("3fff::", 20, "ipv6"); // documentation
BLOCKED_IPV6.addSubnet("5f00::", 16, "ipv6"); // SRv6 SIDs
for (const [network, prefix] of BLOCKED_IPV4_CIDRS) {
	BLOCKED_IPV6.addSubnet(`64:ff9b::${network}`, 96 + prefix, "ipv6");
}

export class UnsafeUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsafeUrlError";
	}
}

export class ResponseTooLargeError extends Error {
	constructor(host: string, maxBytes: number) {
		super(`Response from ${host} exceeded ${maxBytes} bytes`);
		this.name = "ResponseTooLargeError";
	}
}

export type ResolvedAddress = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type Requester = (
	options: https.RequestOptions,
	onResponse: (res: http.IncomingMessage) => void,
) => http.ClientRequest;

export type FetchPublicOptions = {
	headers?: Record<string, string>;
	signal?: AbortSignal | null;
	/** One deadline for DNS, connect, headers, body, and every redirect. */
	timeoutMs: number;
	/** Cap on both received and decoded body bytes. */
	maxBytes: number;
	/** Label used in UnsafeUrlError messages, e.g. "Wayback URL". */
	context?: string;
	resolve?: Resolver;
	request?: Requester;
};

export type PublicResponse = {
	url: string;
	status: number;
	ok: boolean;
	headers: Headers;
	body: Buffer;
	text(): string;
	json(): unknown;
};

type Hop =
	| { location: string }
	| { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

export function assertSafeWebUrl(url: string, context = "URL"): URL {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		throw new UnsafeUrlError(`${context} is invalid`);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new UnsafeUrlError(`${context} is not allowed: only http(s) URLs are supported`);
	}

	if (parsed.username || parsed.password) {
		throw new UnsafeUrlError(`${context} is not allowed: embedded credentials are blocked`);
	}

	if (parsed.port === "0") {
		throw new UnsafeUrlError(`${context} is not allowed: port 0 is invalid`);
	}

	const hostname = normalizeHostname(parsed.hostname);
	if (!hostname) {
		throw new UnsafeUrlError(`${context} is not allowed: missing hostname`);
	}

	if (isBlockedHostname(hostname)) {
		throw new UnsafeUrlError(`${context} is not allowed: local hostnames are blocked`);
	}

	if (isIP(hostname) !== 0 && !isPublicAddress(hostname)) {
		throw new UnsafeUrlError(`${context} is not allowed: private, local, or reserved IP addresses are blocked`);
	}

	return parsed;
}

export function isPublicAddress(address: string): boolean {
	const ip = normalizeHostname(address);
	const version = isIP(ip);
	if (version === 4) return !BLOCKED_IPV4.check(ip, "ipv4");
	if (version === 6) {
		return PUBLIC_IPV6.check(ip, "ipv6") && !BLOCKED_IPV4.check(ip, "ipv6") && !BLOCKED_IPV6.check(ip, "ipv6");
	}
	return false;
}

export async function fetchPublic(url: string, options: FetchPublicOptions): Promise<PublicResponse> {
	const context = options.context ?? "URL";
	let current = assertSafeWebUrl(url, context);
	const deadline = startDeadline(options.signal, options.timeoutMs, current.host);
	try {
		for (let redirects = 0; ; redirects++) {
			const hopContext = redirects === 0 ? context : "redirect URL";
			const pinned = await resolvePublicAddress(current, hopContext, options.resolve ?? lookupAll, deadline.signal);
			deadline.signal.throwIfAborted();
			const hop = await requestOnce(current, pinned, options, deadline.signal);
			if (!("location" in hop)) return toResponse(current, hop, options.maxBytes);
			if (redirects >= MAX_REDIRECTS) {
				throw new Error(`Too many redirects while fetching ${url}`);
			}
			current = assertSafeWebUrl(resolveLocation(hop.location, current), "redirect URL");
		}
	} finally {
		deadline.dispose();
	}
}

function normalizeHostname(hostname: string): string {
	return hostname.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
	if (BLOCKED_HOSTNAMES.has(hostname)) return true;
	if (hostname.endsWith(".localhost")) return true;
	if (hostname.endsWith(".local")) return true;
	if (hostname.endsWith(".home.arpa")) return true;

	// Single-label names are almost always local/intranet hosts, not public web URLs.
	if (!hostname.includes(".") && isIP(hostname) === 0) return true;

	return false;
}

function resolveLocation(location: string, base: URL): string {
	try {
		return new URL(location, base).toString();
	} catch {
		throw new UnsafeUrlError("redirect URL is invalid");
	}
}

async function lookupAll(hostname: string): Promise<ResolvedAddress[]> {
	return lookup(hostname, { all: true, verbatim: true });
}

function startDeadline(callerSignal: AbortSignal | null | undefined, timeoutMs: number, host: string) {
	const controller = new AbortController();
	const onAbort = () => controller.abort(namedError("AbortError", `Request to ${host} was aborted`));
	const timer = setTimeout(
		() => controller.abort(namedError("TimeoutError", `Request to ${host} timed out after ${timeoutMs} ms`)),
		timeoutMs,
	);
	if (callerSignal?.aborted) onAbort();
	else callerSignal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		dispose() {
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", onAbort);
		},
	};
}

function namedError(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

async function resolvePublicAddress(
	url: URL,
	context: string,
	resolve: Resolver,
	signal: AbortSignal,
): Promise<ResolvedAddress> {
	signal.throwIfAborted();
	const hostname = normalizeHostname(url.hostname);
	const literal = isIP(hostname);
	if (literal !== 0) return { address: hostname, family: literal };

	const answers = await raceAbort(resolve(hostname), signal);
	if (answers.length === 0) throw new Error(`${hostname} did not resolve to any address`);

	const blocked = answers.find((entry) => !isPublicAddress(entry.address));
	if (blocked) {
		throw new UnsafeUrlError(`${context} is not allowed: ${hostname} resolves to blocked IP ${blocked.address}`);
	}

	// Prefer IPv4 so hosts with broken IPv6 keep working as they did before pinning.
	const address = normalizeHostname((answers.find((entry) => isIP(entry.address) === 4) ?? answers[0]).address);
	return { address, family: isIP(address) };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	promise.catch(() => undefined); // a resolver may reject after we stop waiting
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function requestOptions(url: URL, pinned: ResolvedAddress, headers: Record<string, string> = {}): https.RequestOptions {
	const hostname = normalizeHostname(url.hostname);
	return {
		protocol: url.protocol,
		hostname,
		port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
		path: `${url.pathname}${url.search}`,
		method: "GET",
		headers: { ...headers, Host: url.host, "Accept-Encoding": "identity" },
		agent: false,
		autoSelectFamily: false,
		family: pinned.family,
		lookup: pinnedLookup(pinned),
		...(isIP(hostname) === 0 ? { servername: hostname } : {}),
	};
}

// Answers every lookup form (options or not, all or single) with the vetted address.
function pinnedLookup(pinned: ResolvedAddress) {
	return (_hostname: string, options: unknown, callback?: (...args: unknown[]) => void) => {
		const cb = typeof options === "function" ? (options as (...args: unknown[]) => void) : callback;
		if (!cb) throw new Error("lookup callback missing");
		if ((options as { all?: boolean } | null)?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
		else cb(null, pinned.address, pinned.family);
	};
}

function defaultRequest(options: https.RequestOptions, onResponse: (res: http.IncomingMessage) => void) {
	return (options.protocol === "https:" ? https : http).request(options, onResponse);
}

function requestOnce(url: URL, pinned: ResolvedAddress, options: FetchPublicOptions, signal: AbortSignal): Promise<Hop> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let received = 0;
		let settled = false;
		let res: http.IncomingMessage | undefined;

		const finish = (error: unknown, hop?: Hop) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			res?.destroy();
			req.destroy();
			if (hop) resolve(hop);
			else reject(error);
		};
		const onAbort = () => finish(signal.reason);

		const request = options.request ?? defaultRequest;
		const req = request(requestOptions(url, pinned, options.headers), (response) => {
			res = response;
			response.on("error", (error) => finish(error));
			response.on("close", () =>
				finish(new Error(`Connection to ${url.host} closed before the response completed`)),
			);

			const status = response.statusCode ?? 0;
			const location = response.headers.location;
			if (REDIRECT_STATUSES.has(status) && location) {
				finish(null, { location });
				return;
			}

			response.on("data", (chunk: Buffer) => {
				received += chunk.length;
				if (received > options.maxBytes) {
					finish(new ResponseTooLargeError(url.host, options.maxBytes));
					return;
				}
				chunks.push(chunk);
			});
			response.on("end", () => finish(null, { status, headers: response.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", (error) => finish(error));
		signal.addEventListener("abort", onAbort, { once: true });
		req.end();
	});
}

const DECODERS: Record<string, (body: Buffer, options: zlib.ZlibOptions) => Buffer> = {
	gzip: zlib.gunzipSync,
	"x-gzip": zlib.gunzipSync,
	deflate: zlib.inflateSync,
	br: zlib.brotliDecompressSync,
};

function decodeBody(body: Buffer, encodingHeader: string | undefined, host: string, maxBytes: number): Buffer {
	const encoding = (encodingHeader ?? "").trim().toLowerCase();
	if (encoding === "" || encoding === "identity" || body.length === 0) return body;

	const decode = DECODERS[encoding];
	if (!decode) throw new Error(`Response from ${host} uses unsupported content-encoding ${encoding}`);
	try {
		return decode(body, { maxOutputLength: maxBytes });
	} catch (error) {
		if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new ResponseTooLargeError(host, maxBytes);
		throw new Error(`Could not decode ${encoding} response from ${host}: ${(error as Error).message}`);
	}
}

function toResponse(url: URL, hop: Exclude<Hop, { location: string }>, maxBytes: number): PublicResponse {
	const body = decodeBody(hop.body, hop.headers["content-encoding"], url.host, maxBytes);
	const headers = new Headers();
	for (const [name, value] of Object.entries(hop.headers)) {
		if (value == null) continue;
		for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
	}
	const text = () => new TextDecoder().decode(body);
	return {
		url: url.toString(),
		status: hop.status,
		ok: hop.status >= 200 && hop.status < 300,
		headers,
		body,
		text,
		json: () => JSON.parse(text()),
	};
}
