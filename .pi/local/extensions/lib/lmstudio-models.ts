const SKIP_TYPES = new Set(["embedding", "embeddings", "reranker", "reranking"]);

export type LmStudioFamily = "qwen" | "gemma" | "other";

export type LmStudioCompat = {
	supportsDeveloperRole: false;
	supportsReasoningEffort: false;
	maxTokensField: "max_tokens";
	thinkingFormat?: "qwen-chat-template";
};

export type LmStudioModel = {
	id: string;
	name: string;
	family: LmStudioFamily;
	reasoning: boolean;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
	compat: LmStudioCompat;
};

const BASE_COMPAT: LmStudioCompat = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
};

export function modelFamily(id: string, name = "", arch = ""): LmStudioFamily {
	const hay = `${id} ${name} ${arch}`.toLowerCase();
	if (hay.includes("gemma")) return "gemma";
	if (hay.includes("qwen")) return "qwen";
	return "other";
}

export function compatForFamily(family: LmStudioFamily): LmStudioCompat {
	if (family === "qwen") {
		return { ...BASE_COMPAT, thinkingFormat: "qwen-chat-template" };
	}
	return { ...BASE_COMPAT };
}

function positiveInt(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
		if (typeof value === "string" && /^\d+$/.test(value)) {
			const parsed = Number(value);
			if (parsed > 0) return parsed;
		}
	}
	return undefined;
}

function isChatModel(raw: Record<string, unknown>): boolean {
	const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
	return !SKIP_TYPES.has(type);
}

export function modelFromLmStudio(raw: Record<string, unknown>): LmStudioModel | null {
	if (typeof raw.id !== "string" || !raw.id.trim()) return null;
	if (!isChatModel(raw)) return null;

	const id = raw.id.trim();
	const contextWindow = positiveInt(raw.max_context_length, raw.context_window) ?? 131072;
	const name =
		(typeof raw.display_name === "string" && raw.display_name.trim()) ||
		(typeof raw.name === "string" && raw.name.trim()) ||
		id;
	const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
	const arch = typeof raw.arch === "string" ? raw.arch : "";
	const family = modelFamily(id, name, arch);

	return {
		id,
		name,
		family,
		reasoning: family === "qwen",
		input: type === "vlm" ? ["text", "image"] : ["text"],
		contextWindow,
		maxTokens: Math.min(32768, contextWindow),
		compat: compatForFamily(family),
	};
}

export function modelsFromLmStudioPayload(payload: unknown): LmStudioModel[] {
	const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
	if (!Array.isArray(data)) return [];

	const models: LmStudioModel[] = [];
	const seen = new Set<string>();
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const model = modelFromLmStudio(item as Record<string, unknown>);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}
