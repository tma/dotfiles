/**
 * Context7 Docs Extension
 *
 * Registers `docs_search` and `docs_read` tools that query Context7
 * for up-to-date library documentation and code examples.
 * No API keys required — Context7's public MCP endpoint is called directly via JSON-RPC.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

const ENDPOINT = "https://mcp.context7.com/mcp";
const HEADERS = {
	"Content-Type": "application/json",
	Accept: "application/json, text/event-stream",
};

let rpcId = 0;

async function rpc(method: string, params: Record<string, unknown>): Promise<string> {
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: HEADERS,
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
	});

	if (!res.ok) {
		throw new Error(`Context7 returned ${res.status}`);
	}

	const json = (await res.json()) as {
		result?: { content?: { text?: string }[] };
		error?: { message?: string };
	};

	if (json.error) {
		throw new Error(json.error.message ?? "Context7 RPC error");
	}

	return json.result?.content?.[0]?.text ?? "";
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "docs_search",
		label: "Docs Search",
		description:
			"Search for a library or framework by name and get its Context7 library ID. Call this before docs_read to resolve the correct library.",
		promptSnippet: "Resolve a library name to a Context7 library ID for documentation lookup",
		promptGuidelines: [
			"Call docs_search first to resolve a library name, then docs_read with the returned library ID.",
			"Do not call docs_search more than 3 times per question.",
		],
		parameters: Type.Object({
			libraryName: Type.String({ description: "Library or framework name, e.g. 'next.js', 'express', 'react'" }),
			query: Type.String({ description: "What you need help with, used to rank results by relevance" }),
		}),

		async execute(_toolCallId, params) {
			const text = await rpc("tools/call", {
				name: "resolve-library-id",
				arguments: { libraryName: params.libraryName, query: params.query },
			});

			return {
				content: [{ type: "text", text: text || "No libraries found." }],
				details: { libraryName: params.libraryName, length: text.length },
			};
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as { libraryName: string; length: number };
			let line = d.length > 0
				? theme.fg("success", "Resolved") + theme.fg("muted", ` "${d.libraryName}"`)
				: theme.fg("warning", "No libraries found") + theme.fg("muted", ` for "${d.libraryName}"`);
			if (expanded) {
				line += "\n" + theme.fg("dim", result.content?.[0]?.text ?? "");
			}
			return new Text(line, 0, 0);
		},
	});

	pi.registerTool({
		name: "docs_read",
		label: "Docs Read",
		description:
			"Query documentation and code examples for a specific library using its Context7 library ID (from docs_search).",
		promptSnippet: "Fetch library documentation and code examples from Context7",
		promptGuidelines: [
			"You must call docs_search first to get the library ID, unless the user provides one directly (e.g. '/vercel/next.js').",
			"Do not call docs_read more than 3 times per question.",
		],
		parameters: Type.Object({
			libraryId: Type.String({
				description: "Context7 library ID from docs_search, e.g. '/vercel/next.js' or '/vercel/next.js/v14.3.0-canary.87'",
			}),
			query: Type.String({ description: "Specific question about the library, e.g. 'how to set up middleware'" }),
		}),

		async execute(_toolCallId, params) {
			const text = await rpc("tools/call", {
				name: "query-docs",
				arguments: { libraryId: params.libraryId, query: params.query },
			});

			const kb = (text.length / 1024).toFixed(1);
			return {
				content: [{ type: "text", text: text || "No documentation found." }],
				details: { libraryId: params.libraryId, query: params.query, kb },
			};
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as { libraryId: string; query: string; kb: string };
			let line = theme.fg("success", `${d.kb}KB docs`) + theme.fg("muted", ` from ${d.libraryId}`) + theme.fg("dim", ` — "${d.query}"`);
			if (expanded) {
				line += "\n" + theme.fg("dim", result.content?.[0]?.text ?? "");
			}
			return new Text(line, 0, 0);
		},
	});
}
