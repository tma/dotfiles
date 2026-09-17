import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsafeUrlError";
	}
}

export type LocalBase = {
	origin: string;
	pathPrefix: string;
	hostname: string;
};

export function normalizeHostname(hostname: string): string {
	return hostname.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

export function isLocalIpv4(hostname: string): boolean {
	const octets = hostname.split(".").map((part) => Number(part));
	if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return false;
	}

	const [a, b] = octets;
	return (
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // CGNAT / Tailscale
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
}

export function isLocalIpv6(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	const embeddedIpv4 = lower.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
	if (embeddedIpv4) return isLocalIpv4(embeddedIpv4);
	return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd");
}

export function isLocalIp(address: string): boolean {
	const hostname = normalizeHostname(address);
	const version = isIP(hostname);
	if (version === 4) return isLocalIpv4(hostname);
	if (version === 6) return isLocalIpv6(hostname);
	return false;
}

export function parseLocalOrigin(raw: string, label = "URL"): LocalBase {
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		throw new UnsafeUrlError(`${label} is invalid`);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new UnsafeUrlError(`${label} must be http or https`);
	}

	if (parsed.username || parsed.password) {
		throw new UnsafeUrlError(`${label} must not include credentials`);
	}

	const hostname = normalizeHostname(parsed.hostname);
	if (!hostname) {
		throw new UnsafeUrlError(`${label} is missing a hostname`);
	}

	if (isIP(hostname) !== 0 && !isLocalIp(hostname)) {
		throw new UnsafeUrlError(`${label} host ${hostname} is not a local address`);
	}

	let pathPrefix = parsed.pathname.replace(/\/+$/, "");
	if (pathPrefix === "/") pathPrefix = "";

	return {
		origin: parsed.origin,
		pathPrefix,
		hostname,
	};
}

export function localApiUrl(base: LocalBase, apiPath: string): URL {
	const rel = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
	const target = new URL(`${base.origin}${base.pathPrefix}${rel}`);
	if (target.origin !== base.origin) {
		throw new UnsafeUrlError("Refusing to call a host other than the configured origin");
	}
	if (base.pathPrefix && target.pathname !== base.pathPrefix && !target.pathname.startsWith(`${base.pathPrefix}/`)) {
		throw new UnsafeUrlError("Refusing to call a path outside the configured origin");
	}
	return target;
}

export function pickLocalAddresses(hostname: string, addresses: string[]): string[] {
	const local = [...new Set(addresses.map(normalizeHostname).filter((address) => isLocalIp(address)))];
	if (local.length === 0) {
		throw new UnsafeUrlError(
			addresses.length === 0 ? `${hostname} did not resolve` : `${hostname} did not resolve to a local address`,
		);
	}
	return local;
}

export function preferLocalAddress(addresses: string[]): string {
	const ip = addresses.find((address) => isIP(address) === 4) ?? addresses[0];
	if (!ip) throw new UnsafeUrlError("No local IP to pin");
	return ip;
}

export function pinLookup(
	ip: string,
	family: 4 | 6,
	options: unknown,
	callback?: (err: Error | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void,
): void {
	const cb = typeof options === "function" ? options : callback;
	if (typeof cb !== "function") throw new UnsafeUrlError("lookup callback missing");
	const all = typeof options === "object" && options != null && Boolean((options as { all?: boolean }).all);
	if (all) {
		cb(null, [{ address: ip, family }]);
		return;
	}
	cb(null, ip, family);
}

export function assertLocalAddresses(hostname: string, addresses: string[]): string[] {
	return pickLocalAddresses(hostname, addresses);
}

export async function resolveLocalAddresses(hostname: string): Promise<string[]> {
	const host = normalizeHostname(hostname);
	if (isIP(host) !== 0) {
		return pickLocalAddresses(host, [host]);
	}

	const entries = await lookup(host, { all: true, verbatim: true });
	return pickLocalAddresses(
		host,
		entries.map((entry) => entry.address),
	);
}

export async function assertHostnameResolvesLocal(hostname: string): Promise<string[]> {
	return resolveLocalAddresses(hostname);
}

function headerRecord(headers?: HeadersInit): http.OutgoingHttpHeaders {
	if (!headers) return {};
	if (headers instanceof Headers) return Object.fromEntries(headers.entries());
	if (Array.isArray(headers)) return Object.fromEntries(headers);
	return { ...headers };
}

export async function fetchLocal(url: URL, init: RequestInit = {}): Promise<Response> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new UnsafeUrlError("Only http and https are allowed");
	}

	const ip = preferLocalAddress(await resolveLocalAddresses(url.hostname));
	const family = isIP(ip) === 6 ? 6 : 4;
	const headers = headerRecord(init.headers);
	if (headers.Host == null && headers.host == null) {
		headers.Host = url.host;
	}

	return await new Promise((resolve, reject) => {
		const lib = url.protocol === "https:" ? https : http;
		const req = lib.request(
			url,
			{
				method: (init.method ?? "GET").toUpperCase(),
				headers,
				lookup(_hostname, options, callback) {
					pinLookup(ip, family === 6 ? 6 : 4, options, callback);
				},
				autoSelectFamily: false,
				servername: url.hostname,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				res.on("end", () => {
					const incoming = new Headers();
					for (const [name, value] of Object.entries(res.headers)) {
						if (value == null) continue;
						incoming.set(name, Array.isArray(value) ? value.join(", ") : value);
					}
					resolve(
						new Response(Buffer.concat(chunks), {
							status: res.statusCode ?? 0,
							headers: incoming,
						}),
					);
				});
			},
		);

		req.on("error", reject);
		if (init.signal) {
			const abort = () => req.destroy(new Error("aborted"));
			if (init.signal.aborted) abort();
			else init.signal.addEventListener("abort", abort, { once: true });
		}
		req.end();
	});
}
