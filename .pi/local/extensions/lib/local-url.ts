import { lookup } from "node:dns/promises";
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

export function parseLocalOrigin(raw: string): LocalBase {
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		throw new UnsafeUrlError("PAPERLESS_URL is invalid");
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new UnsafeUrlError("PAPERLESS_URL must be http or https");
	}

	if (parsed.username || parsed.password) {
		throw new UnsafeUrlError("PAPERLESS_URL must not include credentials");
	}

	const hostname = normalizeHostname(parsed.hostname);
	if (!hostname) {
		throw new UnsafeUrlError("PAPERLESS_URL is missing a hostname");
	}

	if (isIP(hostname) !== 0 && !isLocalIp(hostname)) {
		throw new UnsafeUrlError(`PAPERLESS_URL host ${hostname} is not a local address`);
	}

	let pathPrefix = parsed.pathname.replace(/\/+$/, "");
	if (pathPrefix === "/") pathPrefix = "";

	return {
		origin: parsed.origin,
		pathPrefix,
		hostname,
	};
}

export function paperlessApiUrl(base: LocalBase, apiPath: string): URL {
	const rel = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
	const target = new URL(`${base.origin}${base.pathPrefix}${rel}`);
	if (target.origin !== base.origin) {
		throw new UnsafeUrlError("Refusing to call a host other than PAPERLESS_URL");
	}
	if (base.pathPrefix && target.pathname !== base.pathPrefix && !target.pathname.startsWith(`${base.pathPrefix}/`)) {
		throw new UnsafeUrlError("Refusing to call a path outside PAPERLESS_URL");
	}
	return target;
}

export function assertLocalAddresses(hostname: string, addresses: string[]): void {
	if (addresses.length === 0) {
		throw new UnsafeUrlError(`${hostname} did not resolve`);
	}
	for (const address of addresses) {
		if (!isLocalIp(address)) {
			throw new UnsafeUrlError(`${hostname} resolves to non-local address ${address}`);
		}
	}
}

export async function assertHostnameResolvesLocal(hostname: string): Promise<void> {
	if (isIP(hostname) !== 0) {
		if (!isLocalIp(hostname)) {
			throw new UnsafeUrlError(`${hostname} is not a local address`);
		}
		return;
	}

	const addresses = await lookup(hostname, { all: true, verbatim: true });
	assertLocalAddresses(
		hostname,
		addresses.map((entry) => entry.address),
	);
}
