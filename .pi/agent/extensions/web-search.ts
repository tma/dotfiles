/**
 * Web Search Extension
 *
 * Registers `web_search` and `web_read` tools.
 * - web_search: DuckDuckGo lite search
 * - web_read: Fetch URLs with smart extraction, Jina Reader fallback,
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
const UA_BOT = "pi-coding-agent/1.0"; // DDG lite blocks browser UAs, wants bot-like agents
const MAX_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const JINA_PREFIX = "https://r.jina.ai/";
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
			// DDG blocks Node.js fetch (TLS fingerprinting). Use curl instead.
			const html = await curlPost(
				"https://lite.duckduckgo.com/lite/",
				`q=${encodeURIComponent(params.query)}`,
				signal,
			);
			const results = parseDDGLite(html);

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No results found." }],
					details: { query: params.query, count: 0 },
				};
			}

			const text = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
				.join("\n\n");

			return {
				content: [{ type: "text", text }],
				details: { query: params.query, count: results.length },
			};
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as { query: string; count: number };
			let line = theme.fg("success", `${d.count} results`) + theme.fg("muted", ` for "${d.query}"`);
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
			"Automatically detects GitHub file URLs (serves raw content) and falls back to Jina Reader for JS-heavy or blocked pages.",
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
			const d = result.details as { url?: string; length?: number; source?: string };
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

type ReadResult = { text: string; source: "direct" | "jina" | "github-raw" };

async function readUrl(url: string, signal?: AbortSignal | null): Promise<ReadResult> {
	const inputUrl = assertSafeWebUrl(url).toString();

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
		} catch (error) {
			if (error instanceof UnsafeUrlError) throw error;
			// Fall through to normal fetch
		}
	}

	// Direct fetch
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
			// Otherwise fall through to Jina
		}
	} catch (error) {
		if (error instanceof UnsafeUrlError) throw error;
		// Fall through to Jina
	}

	// Jina Reader fallback — handles JS-rendered, anti-bot, SPAs
	try {
		const jinaUrl = assertSafeWebUrl(JINA_PREFIX + inputUrl, "Jina Reader URL");
		await assertPublicDns(jinaUrl, "Jina Reader URL");
		const res = await fetchWithTimeout(jinaUrl.toString(), {
			headers: {
				"User-Agent": UA,
				Accept: "text/markdown",
			},
			signal,
		});
		if (res.ok) {
			let text = await res.text();
			text = truncate(text);
			if (text.length > 0) {
				return { text, source: "jina" };
			}
		}
	} catch (error) {
		if (error instanceof UnsafeUrlError) throw error;
		// Nothing worked
	}

	throw new Error(`Failed to fetch content from ${inputUrl} (tried direct + Jina Reader)`);
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
	init?: RequestInit & { signal?: AbortSignal | null },
): Promise<Response> {
	const controller = new AbortController();
	const externalSignal = init?.signal;

	// Link external signal
	if (externalSignal?.aborted) {
		controller.abort(externalSignal.reason);
	} else if (externalSignal) {
		externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
	}

	const timer = setTimeout(() => controller.abort(new Error("Fetch timeout")), FETCH_TIMEOUT_MS);

	try {
		const { signal: _externalSignal, ...fetchInit } = init ?? {};
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
			headers: { "User-Agent": UA },
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

function curlPost(url: string, body: string, signal?: AbortSignal | null): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = execFile(
			"curl",
			["-s", "-X", "POST", url, "-H", "Content-Type: application/x-www-form-urlencoded", "-H", `User-Agent: ${UA_BOT}`, "-d", body, "--max-time", String(FETCH_TIMEOUT_MS / 1000)],
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

// ── DuckDuckGo parsing ──────────────────────────────────────────────

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

function parseDDGLite(html: string): SearchResult[] {
	const results: SearchResult[] = [];

	const linkRe =
		/<a[^>]+class='result-link'[^>]*href="([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/a>|<a[^>]+href="([^"]+)"[^>]*class='result-link'[^>]*>\s*([\s\S]*?)\s*<\/a>/gi;
	const snippetRe = /<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

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
			snippet: snippets[i] ?? "",
		});
	}

	return results;
}

function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, "");
}
