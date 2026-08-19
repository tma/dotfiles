/**
 * Web Search Extension
 *
 * Registers `web_search` and `web_read` tools.
 * - web_search: DuckDuckGo lite, with Marginalia and Hacker News as fallbacks
 * - web_read: Fetch URLs with smart extraction, Wayback Machine fallback,
 *   GitHub raw file detection, and multi-URL support.
 *
 * No API keys, no Docker, no MCP.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_BOT = "pi-coding-agent/1.0";
const MAX_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const WAYBACK_PREFIX = "https://web.archive.org/web/2/";
const MARGINALIA_ENDPOINT = "https://api.marginalia.nu/public/search/";
const HN_ENDPOINT = "https://hn.algolia.com/api/v1/search";
const GOOGLE_NEWS_ENDPOINT = "https://news.google.com/rss/search";
const WIKIPEDIA_ENDPOINT = "https://en.wikipedia.org/w/api.php";
const DDG_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const DDG_ATTEMPTS = 2;
// DuckDuckGo challenges by IP and keeps doing it for a while once it starts.
// Retrying through that only digs the hole deeper, so back off for a bit.
const DDG_COOLDOWN_MS = 10 * 60_000;
// DuckDuckGo challenges some agents some of the time, and which one it dislikes
// changes. Rotating through a few makes a retry more likely to land.
const DDG_AGENTS = [UA_BOT, "Mozilla/5.0", UA];
const SEARCH_TIMEOUT_MS = 8_000;
const SEARCH_RESULT_LIMIT = 10;
const MIN_CONTENT_LENGTH = 200; // below this, content is probably garbage
const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
	"broadcasthost",
	"host.docker.internal",
]);

class UnsafeUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsafeUrlError";
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using DuckDuckGo and return a list of results with titles, URLs, and snippets.",
		promptSnippet: "Search the web via DuckDuckGo for current information",
		promptGuidelines: [
			"Use web_search when the user asks about current events, recent releases, or anything not in your training data.",
			"Follow up with web_read to get full page content when a search result looks relevant.",
			"Do not call docs_search more than 3 times per question.",
			"Do not call docs_read more than 3 times per question.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
		}),

		async execute(_toolCallId, params, signal) {
			const { results, provider, attempts } = await runSearch(params.query, signal);

			if (results.length === 0) {
				// Say which backend failed and how. "No results found" hides bot
				// challenges and rate limits, which is what usually happened.
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `No results for "${params.query}".\n\n${formatAttempts(attempts)}`,
						},
					],
					details: { query: params.query, count: 0, provider: null, attempts },
				};
			}

			const text = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
				.join("\n\n");

			return {
				content: [{ type: "text", text: `Source: ${provider}\n\n${text}` }],
				details: { query: params.query, count: results.length, provider, attempts },
			};
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as {
				query: string;
				count: number;
				provider: string | null;
				attempts: SearchAttempt[];
			};
			if (result.isError || d.count === 0) {
				let line =
					theme.fg("error", "No results") + theme.fg("muted", ` for "${d.query}"`);
				if (expanded) {
					line += "\n" + theme.fg("dim", formatAttempts(d.attempts ?? []));
				}
				return new Text(line, 0, 0);
			}
			let line =
				theme.fg("success", `${d.count} results`) +
				theme.fg("muted", ` for "${d.query}" via ${d.provider}`);
			if (expanded) {
				line += "\n" + theme.fg("dim", result.content?.[0]?.text ?? "");
			}
			return new Text(line, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_read",
		label: "Web Read",
		description:
			"Fetch a URL and extract its text content, stripping HTML tags. Supports multiple URLs. " +
			"Only http(s) public web URLs are allowed; localhost, private IPs, and unsafe redirects are blocked. " +
			"Automatically detects GitHub file URLs (serves raw content) and falls back to the Wayback Machine for blocked pages.",
		promptSnippet: "Fetch and read a web page as plain text",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
		}),

		async execute(_toolCallId, params, signal) {
			const result = await readUrl(params.url, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: { url: params.url, length: result.text.length, source: result.source },
			};
		},

		renderResult(result, { expanded }, theme) {
			const d = (result.details ?? {}) as { url?: string; length?: number; source?: string };
			if (result.isError || d.length == null) {
				const msg = result.content?.[0]?.text ?? "Failed to fetch";
				let line = theme.fg("error", "Failed") + theme.fg("muted", d.url ? ` ${d.url}` : "");
				if (expanded) {
					line += "\n" + theme.fg("dim", msg.slice(0, 500));
				}
				return new Text(line, 0, 0);
			}
			const kb = (d.length / 1024).toFixed(1);
			let line = theme.fg("success", `Fetched ${kb}KB`) + theme.fg("muted", ` from ${d.url} (${d.source})`);
			if (expanded) {
				const preview = (result.content?.[0]?.text ?? "").slice(0, 500);
				line += "\n" + theme.fg("dim", preview + (d.length > 500 ? "…" : ""));
			}
			return new Text(line, 0, 0);
		},
	});
}

// ── URL reading with fallbacks ──────────────────────────────────────

type ReadResult = { text: string; source: "direct" | "wayback" | "github-raw" };
type ReadAttempt = { stage: string; outcome: string };

class ReadFailedError extends Error {
	attempts: ReadAttempt[];
	constructor(url: string, attempts: ReadAttempt[]) {
		const detail = attempts.map((a) => `${a.stage}: ${a.outcome}`).join("; ");
		super(`Failed to fetch ${url} (${detail})`);
		this.name = "ReadFailedError";
		this.attempts = attempts;
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "AbortError" || error.message.includes("timeout")) return "timed out";
		return error.message;
	}
	return String(error);
}

async function readUrl(url: string, signal?: AbortSignal | null): Promise<ReadResult> {
	const inputUrl = assertSafeWebUrl(url).toString();
	const attempts: ReadAttempt[] = [];

	// GitHub file URLs → raw content
	const rawUrl = githubToRaw(inputUrl);
	if (rawUrl) {
		try {
			const safeRawUrl = assertSafeWebUrl(rawUrl, "GitHub raw URL");
			await assertPublicDns(safeRawUrl, "GitHub raw URL");
			const res = await fetchWithTimeout(safeRawUrl.toString(), {
				headers: { "User-Agent": UA },
				signal,
			});
			if (res.ok) {
				let text = await res.text();
				text = truncate(text);
				return { text, source: "github-raw" };
			}
			attempts.push({ stage: "github-raw", outcome: `HTTP ${res.status}` });
		} catch (error) {
			if (error instanceof UnsafeUrlError) throw error;
			attempts.push({ stage: "github-raw", outcome: describeError(error) });
		}
	}

	// Direct fetch
	let thinContent: string | null = null;
	try {
		const res = await fetchSafe(inputUrl, signal);
		if (res.ok) {
			const contentType = res.headers.get("content-type") ?? "";
			const body = await res.text();

			let text: string;
			if (contentType.includes("html")) {
				text = extractContent(body);
			} else if (contentType.includes("json")) {
				text = formatJson(body);
			} else {
				text = body;
			}

			text = truncate(text);

			// If we got reasonable content, return it
			if (text.length >= MIN_CONTENT_LENGTH) {
				return { text, source: "direct" };
			}
			// Hold on to it: thin content still beats failing outright.
			thinContent = text;
			attempts.push({ stage: "direct", outcome: `only ${text.length} chars of text` });
		} else {
			attempts.push({ stage: "direct", outcome: `HTTP ${res.status}` });
		}
	} catch (error) {
		if (error instanceof UnsafeUrlError) throw error;
		attempts.push({ stage: "direct", outcome: describeError(error) });
	}

	// Wayback fallback for pages that block direct fetches. Key-less, but the
	// Internet Archive rate limits hard, so treat it as best effort.
	try {
		const waybackUrl = assertSafeWebUrl(WAYBACK_PREFIX + inputUrl, "Wayback URL");
		await assertPublicDns(waybackUrl, "Wayback URL");
		const res = await fetchWithTimeout(waybackUrl.toString(), {
			headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
			signal,
		});
		if (res.ok) {
			const text = truncate(extractContent(await res.text()));
			if (text.length >= MIN_CONTENT_LENGTH) {
				return { text, source: "wayback" };
			}
			attempts.push({ stage: "wayback", outcome: `only ${text.length} chars of text` });
		} else {
			attempts.push({ stage: "wayback", outcome: `HTTP ${res.status}` });
		}
	} catch (error) {
		if (error instanceof UnsafeUrlError) throw error;
		attempts.push({ stage: "wayback", outcome: describeError(error) });
	}

	if (thinContent !== null && thinContent.length > 0) {
		return { text: thinContent, source: "direct" };
	}

	throw new ReadFailedError(inputUrl, attempts);
}

// ── URL safety ──────────────────────────────────────────────────────

function assertSafeWebUrl(url: string, context = "URL"): URL {
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

	const hostname = normalizeHostname(parsed.hostname);
	if (!hostname) {
		throw new UnsafeUrlError(`${context} is not allowed: missing hostname`);
	}

	if (isBlockedHostname(hostname)) {
		throw new UnsafeUrlError(`${context} is not allowed: local hostnames are blocked`);
	}

	if (isBlockedIpLiteral(hostname)) {
		throw new UnsafeUrlError(`${context} is not allowed: private, local, or reserved IP addresses are blocked`);
	}

	return parsed;
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

function isBlockedIpLiteral(hostname: string): boolean {
	const version = isIP(hostname);
	if (version === 4) return isBlockedIpv4(hostname);
	if (version === 6) return isBlockedIpv6(hostname);
	return false;
}

async function assertPublicDns(url: URL, context = "URL"): Promise<void> {
	const hostname = normalizeHostname(url.hostname);
	if (isIP(hostname) !== 0) return;

	const addresses = await lookup(hostname, { all: true, verbatim: true });
	const blocked = addresses.find((entry) => isBlockedIpLiteral(normalizeHostname(entry.address)));
	if (blocked) {
		throw new UnsafeUrlError(`${context} is not allowed: ${hostname} resolves to blocked IP ${blocked.address}`);
	}
}

function isBlockedIpv4(hostname: string): boolean {
	const octets = hostname.split(".").map((part) => Number(part));
	if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return true;
	}

	const [a, b] = octets;
	return (
		a === 0 || // current network
		a === 10 || // RFC1918
		a === 127 || // loopback
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		(a === 169 && b === 254) || // link-local
		(a === 172 && b >= 16 && b <= 31) || // RFC1918
		(a === 192 && b === 168) || // RFC1918
		(a === 192 && b === 0) || // IETF protocol assignments
		(a === 198 && (b === 18 || b === 19)) || // benchmarking
		a >= 224 // multicast/reserved/broadcast
	);
}

function isBlockedIpv6(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	const embeddedIpv4 = lower.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
	if (embeddedIpv4 && isBlockedIpv4(embeddedIpv4)) return true;

	return (
		lower === "::" ||
		lower === "::1" ||
		lower.startsWith("fc") || // unique local fc00::/7
		lower.startsWith("fd") || // unique local fc00::/7
		lower.startsWith("fe8") || // link-local fe80::/10
		lower.startsWith("fe9") ||
		lower.startsWith("fea") ||
		lower.startsWith("feb") ||
		lower.startsWith("fec") || // deprecated site-local fec0::/10
		lower.startsWith("fed") ||
		lower.startsWith("fee") ||
		lower.startsWith("fef") ||
		lower.startsWith("ff") // multicast
	);
}

// ── GitHub URL handling ─────────────────────────────────────────────

function githubToRaw(url: string): string | null {
	try {
		const u = new URL(url);
		if (u.hostname !== "github.com") return null;

		const parts = u.pathname.split("/").filter(Boolean);
		// github.com/owner/repo/blob/branch/path/to/file
		if (parts.length >= 5 && parts[2] === "blob") {
			const [owner, repo, , branch, ...fileParts] = parts;
			return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fileParts.join("/")}`;
		}
		// github.com/owner/repo/raw/branch/path/to/file
		if (parts.length >= 5 && parts[2] === "raw") {
			const [owner, repo, , branch, ...fileParts] = parts;
			return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fileParts.join("/")}`;
		}
		return null;
	} catch {
		return null;
	}
}

// ── Fetch helpers ───────────────────────────────────────────────────

async function fetchWithTimeout(
	url: string,
	init?: RequestInit & { signal?: AbortSignal | null; timeoutMs?: number },
): Promise<Response> {
	const controller = new AbortController();
	const externalSignal = init?.signal;

	// Link external signal
	if (externalSignal?.aborted) {
		controller.abort(externalSignal.reason);
	} else if (externalSignal) {
		externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
	}

	const timer = setTimeout(
		() => controller.abort(new Error("Fetch timeout")),
		init?.timeoutMs ?? FETCH_TIMEOUT_MS,
	);

	try {
		const { signal: _externalSignal, timeoutMs: _timeoutMs, ...fetchInit } = init ?? {};
		return await fetch(url, {
			...fetchInit,
			signal: controller.signal,
			redirect: init?.redirect ?? "follow",
		});
	} finally {
		clearTimeout(timer);
	}
}

async function fetchSafe(url: string, signal?: AbortSignal | null): Promise<Response> {
	let currentUrl = assertSafeWebUrl(url).toString();
	let redirects = 0;

	while (redirects <= MAX_REDIRECTS) {
		const safeUrl = assertSafeWebUrl(currentUrl, redirects === 0 ? "URL" : "redirect URL");
		await assertPublicDns(safeUrl, redirects === 0 ? "URL" : "redirect URL");
		const res = await fetchWithTimeout(safeUrl.toString(), {
			headers: {
				"User-Agent": UA,
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
				"Accept-Language": "en-US,en;q=0.9",
			},
			signal,
			redirect: "manual",
		});

		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (!location) return res;
			currentUrl = assertSafeWebUrl(new URL(location, safeUrl).toString(), "redirect URL").toString();
			redirects++;
			continue;
		}

		return res;
	}

	throw new Error(`Too many redirects while fetching ${url}`);
}

// ── HTML extraction ─────────────────────────────────────────────────

function extractContent(html: string): string {
	// Try to find the main content area first
	let content = extractMainContent(html);
	if (!content || content.length < MIN_CONTENT_LENGTH) {
		// Fall back to full body extraction
		content = stripHTML(html);
	}
	return content;
}

function extractMainContent(html: string): string | null {
	// Try <article>, <main>, [role="main"], .post-content, .article-body, #content
	const patterns = [
		/<article[^>]*>([\s\S]*?)<\/article>/i,
		/<main[^>]*>([\s\S]*?)<\/main>/i,
		/<div[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/div>/i,
		/<div[^>]*class=["'][^"']*(?:post-content|article-body|entry-content|markdown-body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
	];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]) {
			const text = stripHTML(match[1]);
			if (text.length >= MIN_CONTENT_LENGTH) {
				return text;
			}
		}
	}

	return null;
}

function stripHTML(html: string): string {
	return (
		html
			// Remove non-content blocks
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
			.replace(/<svg[\s\S]*?<\/svg>/gi, "")
			// Remove noisy structural elements
			.replace(/<nav[\s\S]*?<\/nav>/gi, "")
			.replace(/<header[\s\S]*?<\/header>/gi, "")
			.replace(/<footer[\s\S]*?<\/footer>/gi, "")
			.replace(/<aside[\s\S]*?<\/aside>/gi, "")
			.replace(/<form[\s\S]*?<\/form>/gi, "")
			// Remove cookie/consent banners (common class patterns)
			.replace(/<div[^>]*class=["'][^"']*(?:cookie|consent|banner|popup|modal|gdpr)[^"']*["'][\s\S]*?<\/div>/gi, "")
			// Remove HTML comments
			.replace(/<!--[\s\S]*?-->/g, "")
			// Strip remaining tags
			.replace(/<[^>]*>/g, " ")
			// Decode HTML entities
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&mdash;/g, "—")
			.replace(/&ndash;/g, "–")
			.replace(/&hellip;/g, "…")
			.replace(/&lsquo;/g, "'")
			.replace(/&rsquo;/g, "'")
			.replace(/&ldquo;/g, "\u201c")
			.replace(/&rdquo;/g, "\u201d")
			.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
			.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
			// Collapse whitespace
			.replace(/[ \t]+/g, " ")
			.replace(/\n\s*\n\s*\n/g, "\n\n")
			.trim()
	);
}

// ── Utilities ───────────────────────────────────────────────────────

function truncate(text: string): string {
	if (text.length > MAX_CHARS) {
		return text.slice(0, MAX_CHARS) + "\n\n[Truncated]";
	}
	return text;
}

function formatJson(body: string): string {
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return body;
	}
}

// ── curl helper (DDG blocks Node.js fetch via TLS fingerprinting) ───

function curlPost(
	url: string,
	body: string,
	userAgent: string,
	signal?: AbortSignal | null,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = execFile(
			"curl",
			["-s", "-X", "POST", url, "-H", "Content-Type: application/x-www-form-urlencoded", "-H", `User-Agent: ${userAgent}`, "-d", body, "--max-time", String(SEARCH_TIMEOUT_MS / 1000)],
			{ encoding: "utf8", maxBuffer: 1024 * 1024 },
			(err, stdout) => {
				if (err) reject(new Error(`curl failed: ${err.message}`));
				else resolve(stdout);
			},
		);
		if (signal) {
			const kill = () => proc.kill();
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

// ── Search providers ────────────────────────────────────────────────

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

type SearchAttempt = { provider: string; outcome: string };

type SearchProvider = {
	name: string;
	run: (query: string, signal?: AbortSignal | null) => Promise<SearchResult[]>;
};

class SearchBlockedError extends Error {}

// All key-less. DuckDuckGo carries general queries; the rest are narrower
// indexes that answer when DuckDuckGo hands back a challenge. Which fallback
// goes first depends on whether the query is asking about something recent.
const PRIMARY_PROVIDER: SearchProvider = { name: "duckduckgo", run: searchDuckDuckGo };
const MARGINALIA: SearchProvider = { name: "marginalia", run: searchMarginalia };
const GOOGLE_NEWS: SearchProvider = { name: "google news", run: searchGoogleNews };
const HACKER_NEWS: SearchProvider = { name: "hacker news", run: searchHackerNews };
const WIKIPEDIA: SearchProvider = { name: "wikipedia", run: searchWikipedia };

const RECENCY_PATTERN =
	/\b(news|today|yesterday|latest|recent|release[ds]?|announce[ds]?|outage|incident|breach|launch(?:ed|es)?|update[ds]?|20[2-9]\d)\b/i;

function providersFor(query: string): SearchProvider[] {
	return RECENCY_PATTERN.test(query)
		? [PRIMARY_PROVIDER, GOOGLE_NEWS, MARGINALIA, HACKER_NEWS, WIKIPEDIA]
		: [PRIMARY_PROVIDER, MARGINALIA, WIKIPEDIA, HACKER_NEWS, GOOGLE_NEWS];
}

async function runSearch(
	query: string,
	signal?: AbortSignal | null,
): Promise<{ results: SearchResult[]; provider: string | null; attempts: SearchAttempt[] }> {
	const attempts: SearchAttempt[] = [];

	for (const provider of providersFor(query)) {
		try {
			const results = await provider.run(query, signal);
			if (results.length > 0) {
				attempts.push({ provider: provider.name, outcome: `${results.length} results` });
				return { results, provider: provider.name, attempts };
			}
			attempts.push({ provider: provider.name, outcome: "no results" });
		} catch (error) {
			attempts.push({
				provider: provider.name,
				outcome: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { results: [], provider: null, attempts };
}

function formatAttempts(attempts: SearchAttempt[]): string {
	const lines = attempts.map((a) => `- ${a.provider}: ${a.outcome}`).join("\n");
	return `Tried:\n${lines}`;
}

let ddgBlockedUntil = 0;

async function searchDuckDuckGo(query: string, signal?: AbortSignal | null): Promise<SearchResult[]> {
	const now = Date.now();
	if (now < ddgBlockedUntil) {
		const minutes = Math.ceil((ddgBlockedUntil - now) / 60_000);
		throw new SearchBlockedError(`in cooldown after a bot challenge, ${minutes} min left`);
	}

	// DuckDuckGo blocks Node's fetch on TLS fingerprint, so shell out to curl.
	let lastError: Error | null = null;
	for (let attempt = 0; attempt < DDG_ATTEMPTS; attempt++) {
		if (attempt > 0) await delay(1_500);
		const html = await curlPost(
			DDG_ENDPOINT,
			`q=${encodeURIComponent(query)}`,
			DDG_AGENTS[attempt % DDG_AGENTS.length],
			signal,
		);
		if (isDDGChallenge(html)) {
			lastError = new SearchBlockedError("bot challenge, backing off for 10 min");
			continue;
		}
		ddgBlockedUntil = 0;
		return parseDDGLite(html);
	}
	ddgBlockedUntil = Date.now() + DDG_COOLDOWN_MS;
	throw lastError ?? new Error("no response");
}

function isDDGChallenge(html: string): boolean {
	const head = html.slice(0, 4000).toLowerCase();
	return head.includes("challenge") || head.includes("captcha");
}

async function searchMarginalia(query: string, signal?: AbortSignal | null): Promise<SearchResult[]> {
	const res = await fetchWithTimeout(MARGINALIA_ENDPOINT + encodeURIComponent(query), {
		headers: { Accept: "application/json", "User-Agent": UA_BOT },
		signal,
		timeoutMs: SEARCH_TIMEOUT_MS,
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = (await res.json()) as {
		results?: Array<{ url?: string; title?: string; description?: string }>;
	};
	return (body.results ?? [])
		.slice(0, SEARCH_RESULT_LIMIT)
		.filter((r) => r.url && r.title)
		.map((r) => ({
			title: stripTags(r.title ?? ""),
			url: r.url ?? "",
			snippet: stripTags(r.description ?? ""),
		}));
}

async function searchHackerNews(query: string, signal?: AbortSignal | null): Promise<SearchResult[]> {
	const url = `${HN_ENDPOINT}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${SEARCH_RESULT_LIMIT}`;
	const res = await fetchWithTimeout(url, {
		headers: { Accept: "application/json", "User-Agent": UA_BOT },
		signal,
		timeoutMs: SEARCH_TIMEOUT_MS,
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = (await res.json()) as {
		hits?: Array<{ title?: string; url?: string; objectID?: string; points?: number; num_comments?: number }>;
	};
	return (body.hits ?? [])
		.filter((hit) => hit.title)
		.map((hit) => ({
			title: stripTags(hit.title ?? ""),
			url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
			snippet: `Hacker News story, ${hit.points ?? 0} points, ${hit.num_comments ?? 0} comments: https://news.ycombinator.com/item?id=${hit.objectID}`,
		}));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchGoogleNews(query: string, signal?: AbortSignal | null): Promise<SearchResult[]> {
	const url = `${GOOGLE_NEWS_ENDPOINT}?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
	const res = await fetchWithTimeout(url, {
		headers: { Accept: "application/rss+xml", "User-Agent": UA },
		signal,
		timeoutMs: SEARCH_TIMEOUT_MS,
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const xml = await res.text();
	const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
	return items.slice(0, SEARCH_RESULT_LIMIT).flatMap((item) => {
		const title = readXmlTag(item, "title");
		const link = readXmlTag(item, "link");
		if (!title || !link) return [];
		const date = readXmlTag(item, "pubDate");
		const source = readXmlTag(item, "source");
		return [
			{
				title,
				url: link,
				snippet: [source, date].filter(Boolean).join(", "),
			},
		];
	});
}

async function searchWikipedia(query: string, signal?: AbortSignal | null): Promise<SearchResult[]> {
	const url = `${WIKIPEDIA_ENDPOINT}?action=query&list=search&format=json&srlimit=${SEARCH_RESULT_LIMIT}&srsearch=${encodeURIComponent(query)}`;
	const res = await fetchWithTimeout(url, {
		headers: { Accept: "application/json", "User-Agent": UA_BOT },
		signal,
		timeoutMs: SEARCH_TIMEOUT_MS,
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = (await res.json()) as {
		query?: { search?: Array<{ title?: string; snippet?: string }> };
	};
	return (body.query?.search ?? [])
		.filter((hit) => hit.title)
		.map((hit) => ({
			title: hit.title ?? "",
			url: `https://en.wikipedia.org/wiki/${encodeURIComponent((hit.title ?? "").replace(/ /g, "_"))}`,
			snippet: stripTags(hit.snippet ?? ""),
		}));
}

function readXmlTag(xml: string, tag: string): string {
	const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
	if (!match?.[1]) return "";
	const raw = match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
	return stripTags(raw);
}

// ── DuckDuckGo parsing ──────────────────────────────────────────────

function parseDDGLite(html: string): SearchResult[] {
	const results: SearchResult[] = [];

	// DuckDuckGo mixes quote styles in this markup and has changed attribute
	// order before, so accept either.
	const linkRe =
		/<a[^>]+class=['"]result-link['"][^>]*href="([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/a>|<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>\s*([\s\S]*?)\s*<\/a>/gi;
	const snippetRe = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

	const links: { url: string; title: string }[] = [];
	let m: RegExpExecArray | null;

	while ((m = linkRe.exec(html)) !== null) {
		const url = m[1] ?? m[3];
		const title = stripTags(m[2] ?? m[4]).trim();
		if (url.startsWith("http") && title) {
			links.push({ url, title });
		}
	}

	const snippets: string[] = [];
	while ((m = snippetRe.exec(html)) !== null) {
		snippets.push(stripTags(m[1]).trim());
	}

	for (let i = 0; i < links.length; i++) {
		results.push({
			title: links[i].title,
			url: links[i].url,
			snippet: decodeEntities(snippets[i] ?? ""),
		});
	}

	return results.slice(0, SEARCH_RESULT_LIMIT);
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, ""));
}

function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}
