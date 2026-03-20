/**
 * Web Search Extension
 *
 * Registers a `web_search` tool that queries DuckDuckGo's lite HTML endpoint
 * and a `web_read` tool that fetches and extracts text from a URL.
 * No API keys, no Docker, no MCP.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using DuckDuckGo and return a list of results with titles, URLs, and snippets.",
		promptSnippet: "Search the web via DuckDuckGo for current information",
		promptGuidelines: [
			"Use web_search when the user asks about current events, recent releases, or anything not in your training data.",
			"Follow up with web_read to get full page content when a search result looks relevant.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
		}),

		async execute(_toolCallId, params) {
			const res = await fetch("https://lite.duckduckgo.com/lite/", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": "pi-coding-agent/1.0",
				},
				body: `q=${encodeURIComponent(params.query)}`,
			});

			if (!res.ok) {
				throw new Error(`DuckDuckGo returned ${res.status}`);
			}

			const html = await res.text();
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
		description: "Fetch a URL and extract its text content, stripping HTML tags.",
		promptSnippet: "Fetch and read a web page as plain text",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
		}),

		async execute(_toolCallId, params, signal) {
			const res = await fetch(params.url, {
				headers: { "User-Agent": "pi-coding-agent/1.0" },
				signal,
			});

			if (!res.ok) {
				throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
			}

			const contentType = res.headers.get("content-type") ?? "";
			const body = await res.text();

			let text: string;
			if (contentType.includes("html")) {
				text = stripHTML(body);
			} else {
				text = body;
			}

			// Truncate to avoid blowing up context
			const maxChars = 30_000;
			if (text.length > maxChars) {
				text = text.slice(0, maxChars) + "\n\n[Truncated]";
			}

			return {
				content: [{ type: "text", text }],
				details: { url: params.url, length: text.length },
			};
		},
	});
}

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

function parseDDGLite(html: string): SearchResult[] {
	const results: SearchResult[] = [];

	// DDG lite renders results as table rows in groups of 4:
	//   row 1: link (<a> with title + href)
	//   row 2: snippet text (class "result-snippet")
	//   row 3: URL display
	//   row 4: spacer
	// Extract links and snippets, then pair them.

	const linkRe = /<a[^>]+class='result-link'[^>]*href="([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/a>|<a[^>]+href="([^"]+)"[^>]*class='result-link'[^>]*>\s*([\s\S]*?)\s*<\/a>/gi;
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

function stripHTML(html: string): string {
	// Remove script/style blocks, then tags, then collapse whitespace
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<nav[\s\S]*?<\/nav>/gi, "")
		.replace(/<header[\s\S]*?<\/header>/gi, "")
		.replace(/<footer[\s\S]*?<\/footer>/gi, "")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n/g, "\n\n")
		.trim();
}
