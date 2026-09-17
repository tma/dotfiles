/**
 * Read-only Paperless-ngx tools for the local Pi profile.
 *
 * Tools register even if Paperless env vars are missing. Calls fail with a
 * setup error until both are set:
 *   PAPERLESS_URL    local http(s) origin, e.g. http://paperless.example.local:8000
 *   PAPERLESS_TOKEN  Paperless API token
 *
 * The model never passes URLs. Requests stay on PAPERLESS_URL and only after
 * DNS resolves to a local address.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { loadLocalEnv } from "./lib/load-env.ts";
import {
	fetchLocal,
	localApiUrl,
	parseLocalOrigin,
	UnsafeUrlError,
	type LocalBase,
} from "./lib/local-url.ts";

const MAX_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_SIZE = 25;
const DEFAULT_PAGE_SIZE = 10;

type PaperlessConfig = {
	base: LocalBase;
	token: string;
};

function loadConfig(): PaperlessConfig {
	loadLocalEnv();
	const rawUrl = process.env.PAPERLESS_URL?.trim() ?? "";
	const token = process.env.PAPERLESS_TOKEN?.trim() ?? "";
	if (!rawUrl || !token) {
		throw new Error(
			"Set PAPERLESS_URL and PAPERLESS_TOKEN. PAPERLESS_URL must be a local http(s) origin, e.g. http://paperless.example.local:8000",
		);
	}
	return { base: parseLocalOrigin(rawUrl, "PAPERLESS_URL"), token };
}

function snippet(text: string, max = 240): string | undefined {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (!collapsed) return undefined;
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function summarizeDocument(doc: Record<string, unknown>, includeContent: boolean): Record<string, unknown> {
	const content = typeof doc.content === "string" ? doc.content : "";
	const out: Record<string, unknown> = {
		id: doc.id,
		title: doc.title,
		created: doc.created,
		added: doc.added,
		correspondent: doc.correspondent,
		document_type: doc.document_type,
		tags: doc.tags,
		page_count: doc.page_count,
		original_file_name: doc.original_file_name,
		archive_serial_number: doc.archive_serial_number,
	};
	if (includeContent) {
		out.content = content.length > MAX_CHARS ? `${content.slice(0, MAX_CHARS)}\n\n[Truncated]` : content;
	} else {
		const preview = snippet(content);
		if (preview) out.snippet = preview;
	}
	return out;
}

function combinedSignal(signal?: AbortSignal | null): AbortSignal {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	if (!signal) return timeout;
	return AbortSignal.any([signal, timeout]);
}

async function paperlessGet(path: string, signal?: AbortSignal | null): Promise<unknown> {
	const { base, token } = loadConfig();
	const url = localApiUrl(base, path);
	const res = await fetchLocal(url, {
		headers: {
			Authorization: `Token ${token}`,
			Accept: "application/json",
			"User-Agent": "pi-local/1.0",
		},
		signal: combinedSignal(signal),
	});

	const body = await res.text();
	if (!res.ok) {
		const preview = body.replace(/\s+/g, " ").trim().slice(0, 300);
		throw new Error(`Paperless returned HTTP ${res.status}${preview ? `: ${preview}` : ""}`);
	}

	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new Error("Paperless returned non-JSON");
	}
}

function toolError(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
	const text = error instanceof UnsafeUrlError || error instanceof Error ? error.message : String(error);
	return {
		isError: true,
		content: [{ type: "text", text }],
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "paperless_search",
		label: "Paperless Search",
		description:
			"Search Paperless documents. Full-text by default. Also supports title:, correspondent:, tag:, type:, and created:. Empty query lists recent documents.",
		promptSnippet: "Search local Paperless documents",
		promptGuidelines: [
			"Use paperless_search to find documents, then paperless_get for full text.",
			"Do not invent document contents. Only quote what Paperless returned.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Paperless search query. Empty lists recent documents.",
			}),
			page: Type.Optional(Type.Integer({ minimum: 1, description: "Results page (default 1)" })),
		}),

		async execute(_toolCallId, params, signal) {
			try {
				const page = params.page ?? 1;
				const search = new URLSearchParams({
					page: String(page),
					page_size: String(DEFAULT_PAGE_SIZE),
				});
				if (params.query.trim()) search.set("query", params.query.trim());

				const payload = (await paperlessGet(`/api/documents/?${search.toString()}`, signal)) as {
					count?: number;
					next?: string | null;
					results?: Record<string, unknown>[];
				};

				const results = (payload.results ?? []).slice(0, MAX_PAGE_SIZE).map((doc) => summarizeDocument(doc, false));
				const text = JSON.stringify(
					{
						count: payload.count ?? results.length,
						page,
						has_more: Boolean(payload.next),
						results,
					},
					null,
					2,
				);

				return {
					content: [{ type: "text", text }],
					details: { query: params.query, count: results.length, page, total: payload.count ?? results.length },
				};
			} catch (error) {
				return toolError(error);
			}
		},

		renderResult(result, { expanded }, theme) {
			const d = (result.details ?? {}) as { query?: string; count?: number; total?: number };
			if (result.isError) {
				const msg = result.content?.[0]?.text ?? "Search failed";
				let line = theme.fg("error", "Paperless search failed");
				if (expanded) line += `\n${theme.fg("dim", msg)}`;
				return new Text(line, 0, 0);
			}
			const q = d.query?.trim() ? ` for "${d.query}"` : "";
			let line = theme.fg("success", `${d.count ?? 0} shown`) + theme.fg("muted", `${q} (${d.total ?? 0} total)`);
			if (expanded) {
				line += `\n${theme.fg("dim", result.content?.[0]?.text ?? "")}`;
			}
			return new Text(line, 0, 0);
		},
	});

	pi.registerTool({
		name: "paperless_get",
		label: "Paperless Get",
		description: "Fetch one Paperless document by ID, including OCR text.",
		promptSnippet: "Read a local Paperless document by ID",
		parameters: Type.Object({
			id: Type.Integer({ minimum: 1, description: "Paperless document ID" }),
		}),

		async execute(_toolCallId, params, signal) {
			try {
				const payload = (await paperlessGet(`/api/documents/${params.id}/`, signal)) as Record<string, unknown>;
				const doc = summarizeDocument(payload, true);
				return {
					content: [{ type: "text", text: JSON.stringify(doc, null, 2) }],
					details: { id: params.id, title: typeof doc.title === "string" ? doc.title : undefined },
				};
			} catch (error) {
				return toolError(error);
			}
		},

		renderResult(result, { expanded }, theme) {
			const d = (result.details ?? {}) as { id?: number; title?: string };
			if (result.isError) {
				const msg = result.content?.[0]?.text ?? "Get failed";
				let line = theme.fg("error", "Paperless get failed");
				if (expanded) line += `\n${theme.fg("dim", msg)}`;
				return new Text(line, 0, 0);
			}
			const title = d.title ? ` ${d.title}` : "";
			let line = theme.fg("success", `Document ${d.id ?? "?"}`) + theme.fg("muted", title);
			if (expanded) {
				line += `\n${theme.fg("dim", (result.content?.[0]?.text ?? "").slice(0, 500))}`;
			}
			return new Text(line, 0, 0);
		},
	});
}
