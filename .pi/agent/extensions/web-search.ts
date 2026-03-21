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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_BOT = "pi-coding-agent/1.0"; // DDG lite blocks browser UAs, wants bot-like agents
const MAX_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const JINA_PREFIX = "https://r.jina.ai/";
const MIN_CONTENT_LENGTH = 200; // below this, content is probably garbage

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
					details: { query: params.query },
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
	});

	pi.registerTool({
		name: "web_read",
		label: "Web Read",
		description:
			"Fetch a URL and extract its text content, stripping HTML tags. Supports multiple URLs. " +
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
	});
}

// ── URL reading with fallbacks ──────────────────────────────────────

type ReadResult = { text: string; source: "direct" | "jina" | "github-raw" };

async function readUrl(url: string, signal?: AbortSignal | null): Promise<ReadResult> {
	// GitHub file URLs → raw content
	const rawUrl = githubToRaw(url);
	if (rawUrl) {
		try {
			const res = await fetchWithTimeout(rawUrl, {
				headers: { "User-Agent": UA },
				signal,
			});
			if (res.ok) {
				let text = await res.text();
				text = truncate(text);
				return { text, source: "github-raw" };
			}
		} catch {
			// Fall through to normal fetch
		}
	}

	// Direct fetch
	try {
		const res = await fetchSafe(url, signal);
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
	} catch {
		// Fall through to Jina
	}

	// Jina Reader fallback — handles JS-rendered, anti-bot, SPAs
	try {
		const jinaUrl = JINA_PREFIX + url;
		const res = await fetchWithTimeout(jinaUrl, {
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
	} catch {
		// Nothing worked
	}

	throw new Error(`Failed to fetch content from ${url} (tried direct + Jina Reader)`);
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
		return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
	} finally {
		clearTimeout(timer);
	}
}

async function fetchSafe(url: string, signal?: AbortSignal | null): Promise<Response> {
	let currentUrl = url;
	let redirects = 0;

	while (redirects < MAX_REDIRECTS) {
		const res = await fetchWithTimeout(currentUrl, {
			headers: { "User-Agent": UA },
			signal,
			redirect: "manual",
		});

		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (!location) break;
			currentUrl = new URL(location, currentUrl).toString();
			redirects++;
			continue;
		}

		return res;
	}

	// Final attempt with auto-redirect as last resort
	return fetchWithTimeout(currentUrl, {
		headers: { "User-Agent": UA },
		signal,
	});
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
