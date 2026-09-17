/**
 * Discover models from a local LM Studio server.
 *
 * LM_STUDIO_URL defaults to http://127.0.0.1:1234 and must resolve locally.
 * The model list comes only from LM Studio. models.json has no static entries.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { loadLocalEnv } from "./lib/load-env.ts";
import {
	fetchLocal,
	localApiUrl,
	parseLocalOrigin,
	type LocalBase,
} from "./lib/local-url.ts";
import { modelsFromLmStudioPayload, type LmStudioModel } from "./lib/lmstudio-models.ts";

const DEFAULT_URL = "http://127.0.0.1:1234";
const FETCH_TIMEOUT_MS = 2_000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

let lastModels: ProviderModelConfig[] | undefined;
let discoveryWarning: string | undefined;

function loadBase(): LocalBase {
	const raw = process.env.LM_STUDIO_URL?.trim() || DEFAULT_URL;
	const base = parseLocalOrigin(raw, "LM_STUDIO_URL");
	if (base.pathPrefix === "/v1") return { ...base, pathPrefix: "" };
	if (base.pathPrefix.endsWith("/v1")) {
		return { ...base, pathPrefix: base.pathPrefix.slice(0, -3).replace(/\/+$/, "") };
	}
	return base;
}

function openaiBaseUrl(base: LocalBase): string {
	return `${base.origin}${base.pathPrefix}/v1`;
}

function toProviderModels(models: LmStudioModel[]): ProviderModelConfig[] {
	return models.map((model) => ({
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: model.input,
		cost: ZERO_COST,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: model.compat,
	}));
}

async function fetchJson(url: URL, signal: AbortSignal): Promise<unknown> {
	const res = await fetchLocal(url, {
		headers: {
			Accept: "application/json",
			Authorization: "Bearer lm-studio",
		},
		signal,
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function discover(base: LocalBase, signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

	try {
		const v0 = modelsFromLmStudioPayload(await fetchJson(localApiUrl(base, "/api/v0/models"), combined));
		if (v0.length > 0) return toProviderModels(v0);
	} catch {
		// OpenAI /v1/models is enough when the richer v0 endpoint is missing.
	}

	return toProviderModels(modelsFromLmStudioPayload(await fetchJson(localApiUrl(base, "/v1/models"), combined)));
}

export default async function (pi: ExtensionAPI) {
	loadLocalEnv();
	let base: LocalBase;
	try {
		base = loadBase();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(message, "warning");
		});
		return;
	}

	try {
		const models = await discover(base);
		if (models.length > 0) {
			lastModels = models;
		} else {
			discoveryWarning = `LM Studio at ${base.origin} returned no chat models`;
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		discoveryWarning = `LM Studio discovery failed (${detail})`;
	}

	pi.registerProvider("lmstudio", {
		baseUrl: openaiBaseUrl(base),
		apiKey: "lm-studio",
		api: "openai-completions",
		...(lastModels ? { models: lastModels } : {}),
		async refreshModels(context) {
			if (context.signal.aborted || !context.allowNetwork) return lastModels;
			try {
				const models = await discover(base, context.signal);
				if (models.length > 0) {
					lastModels = models;
					return models;
				}
			} catch {
				// Keep the last successful list.
			}
			return lastModels;
		},
	});

	if (discoveryWarning) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(discoveryWarning ?? "LM Studio discovery failed", "warning");
		});
	}
}
