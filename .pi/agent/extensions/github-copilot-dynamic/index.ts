/**
 * github-copilot-dynamic — Dynamic model discovery for GitHub Copilot.
 *
 * Adapted from:
 * https://github.com/Attamusc/dotfiles/blob/main/dot_pi/agent/extensions/github-copilot-dynamic/index.ts
 *
 * Fetches the live /models list from the Copilot API and replaces Pi's static
 * github-copilot catalog with whatever GitHub serves for this account, including
 * models that are not in Pi's generated registry yet (grok-4.6, gemini-3.7-flash, …).
 *
 * Token minting is vendored. `@earendil-works/pi-ai/oauth` is types-only since
 * 0.82.1, so importing `refreshGitHubCopilotToken` throws
 * "… is not a function" on boot whenever the cached Copilot JWT is stale.
 *
 * The minted JWT is in-memory only; auth.json is never written. Built-in
 * github-copilot OAuth is left in place — we only swap the model list.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COPILOT_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
	"X-GitHub-Api-Version": "2026-06-01",
};

const TAG = "[github-copilot-dynamic]";

interface AuthEntry {
	type: string;
	access?: string;
	refresh?: string;
	expires?: number;
	enterpriseUrl?: string;
}

interface CopilotAuth {
	jwt: string;
	baseUrl: string;
	enterpriseUrl?: string;
}

interface RawModel {
	id: string;
	name?: string;
	model_picker_enabled?: boolean;
	policy?: { state: string } | null;
	capabilities?: {
		limits?: {
			max_context_window_tokens?: number;
			max_output_tokens?: number;
		};
		supports?: {
			adaptive_thinking?: boolean;
			reasoning_effort?: string[];
			tool_calls?: boolean;
		};
	};
}

type CopilotApi = "anthropic-messages" | "openai-completions" | "openai-responses";

let lastModels: ProviderModelConfig[] | undefined;

function getGitHubCopilotBaseUrl(token: string | undefined, enterpriseDomain?: string): string {
	const match = token?.match(/proxy-ep=([^;]+)/);
	if (match) return `https://${match[1].replace(/^proxy\./, "api.")}`;
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}

async function mintCopilotJwt(refreshToken: string, enterpriseDomain?: string, signal?: AbortSignal): Promise<string | null> {
	const domain = enterpriseDomain || "github.com";
	try {
		const response = await fetch(`https://api.${domain}/copilot_internal/v2/token`, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${refreshToken}`,
				...COPILOT_HEADERS,
			},
			signal,
		});
		if (!response.ok) {
			console.error(`${TAG} token mint failed: HTTP ${response.status}`);
			return null;
		}
		const raw: unknown = await response.json();
		const token = (raw as { token?: unknown })?.token;
		return typeof token === "string" ? token : null;
	} catch (err: unknown) {
		if (signal?.aborted) return null;
		console.error(`${TAG} token mint failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

function readAuthFile(): Record<string, AuthEntry> | null {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");

	let raw: string;
	try {
		raw = readFileSync(authPath, "utf8");
	} catch {
		return null;
	}

	try {
		return JSON.parse(raw) as Record<string, AuthEntry>;
	} catch {
		console.error(`${TAG} failed to parse auth.json; skipping startup discovery`);
		return null;
	}
}

async function readCopilotAuth(): Promise<CopilotAuth | null> {
	const entry = readAuthFile()?.["github-copilot"];
	if (!entry) return null;

	if (typeof entry.access === "string" && typeof entry.expires === "number" && entry.expires > Date.now()) {
		return {
			jwt: entry.access,
			baseUrl: getGitHubCopilotBaseUrl(entry.access, entry.enterpriseUrl),
			enterpriseUrl: entry.enterpriseUrl,
		};
	}

	if (typeof entry.refresh !== "string" || !entry.refresh) {
		console.error(`${TAG} github-copilot credentials have no refresh token; using Pi's built-in list`);
		return null;
	}

	const minted = await mintCopilotJwt(entry.refresh, entry.enterpriseUrl);
	if (!minted) {
		console.error(`${TAG} could not mint a Copilot JWT; using Pi's built-in list this run`);
		return null;
	}

	return {
		jwt: minted,
		baseUrl: getGitHubCopilotBaseUrl(minted, entry.enterpriseUrl),
		enterpriseUrl: entry.enterpriseUrl,
	};
}

function authFromCredential(credential: RefreshModelsContext["credential"]): CopilotAuth | null {
	if (!credential) return null;

	if (credential.type === "oauth") {
		const enterpriseUrl = typeof credential.enterpriseUrl === "string" ? credential.enterpriseUrl : undefined;
		if (typeof credential.access === "string" && credential.access) {
			return {
				jwt: credential.access,
				baseUrl: getGitHubCopilotBaseUrl(credential.access, enterpriseUrl),
				enterpriseUrl,
			};
		}
		return null;
	}

	if (credential.type === "api_key" && typeof credential.key === "string" && credential.key) {
		return {
			jwt: credential.key,
			baseUrl: getGitHubCopilotBaseUrl(credential.key),
		};
	}

	return null;
}

async function fetchModels(auth: CopilotAuth, signal?: AbortSignal): Promise<RawModel[] | null> {
	let response: Response;
	try {
		response = await fetch(`${auth.baseUrl}/models`, {
			headers: {
				Authorization: `Bearer ${auth.jwt}`,
				Accept: "application/json",
				...COPILOT_HEADERS,
			},
			signal,
		});
	} catch (err: unknown) {
		if (signal?.aborted) return null;
		console.error(`${TAG} /models fetch failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}

	if (!response.ok) {
		console.error(`${TAG} /models returned HTTP ${response.status}; skipping dynamic discovery`);
		return null;
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		console.error(`${TAG} /models response is not valid JSON; skipping dynamic discovery`);
		return null;
	}

	if (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>).data)) {
		console.error(`${TAG} /models response missing .data array; skipping dynamic discovery`);
		return null;
	}

	return (body as { data: RawModel[] }).data;
}

function isModelEligible(model: RawModel): boolean {
	if (model.capabilities?.supports?.tool_calls === false) return false;
	if (model.model_picker_enabled === false) return false;
	if (model.policy?.state === "disabled") return false;
	return true;
}

function getApi(id: string): CopilotApi {
	if (/^claude-fable-/.test(id)) return "openai-completions";
	if (/^claude-/.test(id)) return "anthropic-messages";
	if (/^(gpt-5|grok-|mai-)/.test(id)) return "openai-responses";
	if (/^(gpt-4|gemini|kimi)/.test(id)) return "openai-completions";

	console.error(`${TAG} unknown model id family for "${id}"; defaulting api to openai-completions`);
	return "openai-completions";
}

function getCompat(raw: RawModel): Record<string, boolean> {
	const id = raw.id;

	if (raw.capabilities?.supports?.adaptive_thinking === true || /^claude-(opus|sonnet)-(4\.[6-9]|[5-9])/.test(id)) {
		const compat: Record<string, boolean> = { forceAdaptiveThinking: true };
		if (/^claude-opus-(4\.[7-9]|[5-9])/.test(id)) compat.supportsTemperature = false;
		return compat;
	}

	if (/^(gemini|gpt-4|kimi|claude-fable)/.test(id)) {
		return { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false };
	}

	if (/^gpt-5/.test(id)) {
		return { supportsOpenAIGrammarTools: true };
	}

	if (/^claude-(haiku|sonnet)-4(\.5)?$/.test(id)) {
		return { supportsEagerToolInputStreaming: false };
	}

	return {};
}

function getThinkingLevelMap(raw: RawModel): ProviderModelConfig["thinkingLevelMap"] {
	const efforts = raw.capabilities?.supports?.reasoning_effort;
	if (Array.isArray(efforts) && efforts.length > 0) {
		const has = (value: string) => efforts.includes(value);
		return {
			off: has("off") ? "off" : null,
			minimal: has("minimal") ? "minimal" : has("low") ? "low" : null,
			low: has("low") ? "low" : undefined,
			medium: has("medium") ? "medium" : undefined,
			high: has("high") ? "high" : undefined,
			xhigh: has("xhigh") ? "xhigh" : has("max") ? "max" : null,
			max: has("max") ? "max" : null,
		};
	}

	if (raw.id.startsWith("gpt-5")) {
		return { off: null, minimal: "low", xhigh: "xhigh" };
	}

	if (/^(grok-|mai-)/.test(raw.id)) {
		return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}

	return undefined;
}

function toPiModel(raw: RawModel): ProviderModelConfig {
	return {
		id: raw.id,
		name: raw.name ?? raw.id,
		api: getApi(raw.id),
		headers: { ...COPILOT_HEADERS },
		compat: getCompat(raw),
		reasoning: true,
		thinkingLevelMap: getThinkingLevelMap(raw),
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: raw.capabilities?.limits?.max_context_window_tokens ?? 128000,
		maxTokens: raw.capabilities?.limits?.max_output_tokens ?? 16000,
	};
}

function toEligibleModels(rawModels: RawModel[]): ProviderModelConfig[] {
	return rawModels.filter(isModelEligible).map(toPiModel);
}

async function discoverModels(auth: CopilotAuth, signal?: AbortSignal): Promise<ProviderModelConfig[] | undefined> {
	const rawModels = await fetchModels(auth, signal);
	if (!rawModels) return undefined;

	const models = toEligibleModels(rawModels);
	if (models.length === 0) {
		console.error(`${TAG} /models returned no eligible models after filtering`);
		return undefined;
	}

	lastModels = models;
	return models;
}

export default async function (pi: ExtensionAPI) {
	try {
		const startupAuth = await readCopilotAuth();
		const startupModels = startupAuth ? await discoverModels(startupAuth) : undefined;

		pi.registerProvider("github-copilot", {
			...(startupAuth ? { baseUrl: startupAuth.baseUrl } : {}),
			...(startupModels ? { models: startupModels } : {}),
			async refreshModels(context) {
				// Return undefined (not []) when we have no list, so Pi keeps its built-in catalog.
				if (context.signal.aborted || !context.allowNetwork) return lastModels;

				let auth = authFromCredential(context.credential);
				if (!auth && context.credential?.type === "oauth" && typeof context.credential.refresh === "string") {
					const enterpriseUrl =
						typeof context.credential.enterpriseUrl === "string" ? context.credential.enterpriseUrl : undefined;
					const minted = await mintCopilotJwt(context.credential.refresh, enterpriseUrl, context.signal);
					if (minted) {
						auth = {
							jwt: minted,
							baseUrl: getGitHubCopilotBaseUrl(minted, enterpriseUrl),
							enterpriseUrl,
						};
					}
				}

				if (!auth) return lastModels;

				return (await discoverModels(auth, context.signal)) ?? lastModels;
			},
		});
	} catch (err: unknown) {
		console.error(`${TAG} unexpected error: ${err instanceof Error ? err.message : String(err)}`);
	}
}
