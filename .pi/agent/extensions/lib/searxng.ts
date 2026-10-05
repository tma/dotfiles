/**
 * Optional SearXNG first hop for web_search.
 *
 * SEARXNG_URL is personal infrastructure, so it stays out of this repository.
 * Resolution order:
 *   1. SEARXNG_URL already in the environment
 *   2. SEARXNG_URL in the file named by PI_SEARXNG_ENV
 *   3. SEARXNG_URL in ~/.pi/.env
 *   4. SEARXNG_URL in this repo's .pi/.env (gitignored)
 *
 * ~/.pi/.env sits beside the agent config, not inside the dotfiles-managed
 * ~/.pi/agent tree. Project .env files are not read: those hold app secrets,
 * and a SearXNG URL is not per-project. Point PI_SEARXNG_ENV at one if you
 * really want that file.
 */

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BODY_CHARS = 1_000_000;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RESULT_LIMIT = 10;
const SNIPPET_LIMIT = 500;

export type SearxngResult = {
	title: string;
	url: string;
	snippet: string;
};

export type SearxngConfig =
	| { status: "unset" }
	| { status: "ready"; url: string }
	| { status: "invalid"; error: string };

export function searxngEnvFile(home: string): string {
	return path.join(home, ".pi", ".env");
}

export function searxngRepoEnvFile(moduleUrl = import.meta.url): string {
	const modulePath = fileURLToPath(moduleUrl);
	let dir = path.dirname(modulePath);
	try {
		dir = path.dirname(realpathSync(modulePath));
	} catch {
		// Keep the unresolved path when the module file is not on disk.
	}
	return path.resolve(dir, "../../../.env");
}

export function searxngUrlFromText(text: string): string | null {
	let found: string | null = null;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const cleaned = line.replace(/^export\s+/, "");
		const eq = cleaned.indexOf("=");
		if (eq <= 0) continue;
		const key = cleaned.slice(0, eq).trim();
		if (key !== "SEARXNG_URL") continue;
		found = stripQuotes(cleaned.slice(eq + 1).trim()) || null;
	}
	return found;
}

export function resolveSearxngConfig(input: {
	env: NodeJS.ProcessEnv;
	home: string;
	cwd?: string;
	repoEnvFile?: string | null;
	readFile?: (file: string) => string | null;
}): SearxngConfig {
	const fromProcess = input.env.SEARXNG_URL?.trim();
	if (fromProcess) return toConfig(fromProcess);

	const readFile = input.readFile ?? readEnvFile;
	const explicit = input.env.PI_SEARXNG_ENV?.trim();
	if (explicit) {
		const file = path.resolve(input.cwd ?? process.cwd(), explicit);
		const text = readFile(file);
		if (text == null) return { status: "invalid", error: "PI_SEARXNG_ENV file is missing or unreadable" };
		const value = searxngUrlFromText(text);
		return value ? toConfig(value) : { status: "unset" };
	}

	const files = [searxngEnvFile(input.home)];
	const repoEnvFile = input.repoEnvFile === undefined ? searxngRepoEnvFile() : input.repoEnvFile;
	if (repoEnvFile) files.push(repoEnvFile);
	for (const file of files) {
		const text = readFile(file);
		if (text == null) continue;
		const value = searxngUrlFromText(text);
		if (value) return toConfig(value);
	}
	return { status: "unset" };
}

export function searxngSearchUrl(base: string, query: string): string {
	const url = new URL(parseSearxngBase(base).toString());
	const pathname = url.pathname.replace(/\/+$/, "");
	url.pathname = pathname.endsWith("/search") ? pathname : `${pathname}/search`;
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	return url.toString();
}

export function parseSearxngResults(body: string, limit = DEFAULT_RESULT_LIMIT): SearxngResult[] {
	const trimmed = body.trim();
	if (!trimmed) throw new Error("empty response");
	if (trimmed.startsWith("<")) throw new Error("JSON format disabled");

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error("response was not JSON");
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { results?: unknown }).results)) {
		throw new Error("response missing results");
	}

	const results: SearxngResult[] = [];
	for (const item of (parsed as { results: unknown[] }).results) {
		if (!item || typeof item !== "object") continue;
		const record = item as { title?: unknown; url?: unknown; content?: unknown };
		const title = typeof record.title === "string" ? stripTags(record.title) : "";
		const url = typeof record.url === "string" ? record.url.trim() : "";
		if (!title || !isHttpUrl(url)) continue;
		const snippet = typeof record.content === "string" ? stripTags(record.content).slice(0, SNIPPET_LIMIT) : "";
		results.push({ title, url, snippet });
		if (results.length >= limit) break;
	}
	return results;
}

export async function fetchSearxngResults(
	base: string,
	query: string,
	options?: { signal?: AbortSignal | null; timeoutMs?: number; userAgent?: string; limit?: number },
): Promise<SearxngResult[]> {
	const pinned = parseSearxngBase(base);
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	const external = options?.signal ?? undefined;
	const signal = external ? AbortSignal.any([external, timeout]) : timeout;
	let current = searxngSearchUrl(base, query);

	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		let res: Response;
		try {
			res = await fetch(current, {
				headers: {
					Accept: "application/json",
					"User-Agent": options?.userAgent ?? "pi-coding-agent/1.0",
				},
				signal,
				redirect: "manual",
			});
		} catch (error) {
			if (external?.aborted) throw error;
			if (timeout.aborted) throw new Error("timed out");
			throw new Error("unreachable");
		}

		if (res.status >= 300 && res.status < 400) {
			await res.body?.cancel();
			const location = res.headers.get("location");
			if (!location) throw new Error(`HTTP ${res.status}`);
			const next = new URL(location, current);
			if (!isAllowedRedirect(pinned, next)) throw new Error("redirect left the SearXNG host");
			current = next.toString();
			continue;
		}

		if (!res.ok) {
			const text = await res.text();
			if (/format/i.test(text) && /disabled|not allowed|forbidden/i.test(text)) {
				throw new Error("JSON format disabled");
			}
			throw new Error(`HTTP ${res.status}`);
		}

		const text = await res.text();
		if (text.length > MAX_BODY_CHARS) throw new Error("response too large");
		return parseSearxngResults(text, options?.limit);
	}

	throw new Error("too many redirects");
}

function toConfig(raw: string): SearxngConfig {
	try {
		parseSearxngBase(raw);
		return { status: "ready", url: raw.trim() };
	} catch (error) {
		return { status: "invalid", error: error instanceof Error ? error.message : "SEARXNG_URL is invalid" };
	}
}

function parseSearxngBase(raw: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		throw new Error("SEARXNG_URL is not a valid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("SEARXNG_URL must be http or https");
	}
	if (parsed.username || parsed.password) {
		throw new Error("SEARXNG_URL must not include credentials");
	}
	if (!normalizeHostname(parsed.hostname)) {
		throw new Error("SEARXNG_URL is missing a hostname");
	}
	return parsed;
}

function isAllowedRedirect(pinned: URL, next: URL): boolean {
	if (next.protocol !== "http:" && next.protocol !== "https:") return false;
	if (next.username || next.password) return false;
	if (normalizeHostname(pinned.hostname) !== normalizeHostname(next.hostname)) return false;
	if (originKey(pinned) === originKey(next)) return true;
	// Allow the usual http://host → https://host upgrade, not a jump to another port.
	const fromPort = explicitOrDefaultPort(pinned);
	const toPort = explicitOrDefaultPort(next);
	return pinned.protocol === "http:" && next.protocol === "https:" && (fromPort === toPort || (fromPort === "80" && toPort === "443"));
}

function originKey(url: URL): string {
	return `${url.protocol}//${normalizeHostname(url.hostname)}:${explicitOrDefaultPort(url)}`;
}

function explicitOrDefaultPort(url: URL): string {
	if (url.port) return url.port;
	return url.protocol === "https:" ? "443" : "80";
}

function normalizeHostname(hostname: string): string {
	return hostname.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function stripQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
		(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
	) {
		return value.slice(1, -1).trim();
	}
	return value.trim();
}

function readEnvFile(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function stripTags(value: string): string {
	return value
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}
