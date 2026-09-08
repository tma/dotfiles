export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const AUTO_POLICIES = ["cheap", "balanced", "strong"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type AutoPolicy = (typeof AUTO_POLICIES)[number];

export interface ModelPolicy {
	model?: string;
	thinking?: string;
	provider?: string;
	family?: string;
}

export interface ResolvedPolicy extends ModelPolicy {
	sources: Partial<Record<keyof ModelPolicy, "agent" | "launch" | "item">>;
}

export interface CatalogModel {
	provider: string;
	id: string;
	name?: string;
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

export interface SelectionResult<TModel extends CatalogModel> {
	model: TModel;
	thinkingLevel: ThinkingLevel;
	requestedThinkingLevel: ThinkingLevel;
	reason: string;
}

export interface SelectionOptions<TModel extends CatalogModel> {
	policy: ModelPolicy;
	availableModels: readonly TModel[];
	allModels: readonly TModel[];
	parentModel?: TModel;
	parentThinkingLevel?: string;
	authenticate: (model: TModel) => Promise<{ ok: true } | { ok: false; error: string }>;
	getSupportedThinkingLevels: (model: TModel) => readonly ThinkingLevel[];
	clampThinkingLevel: (model: TModel, level: ThinkingLevel) => ThinkingLevel;
	catalogNotice?: string;
	signal?: AbortSignal;
	/** Total selection/authentication deadline, not a per-candidate timeout. */
	timeoutMs?: number;
}

export interface CatalogRefreshRegistry {
	getError?(): string | undefined;
	refresh(options: { allowNetwork: boolean; signal: AbortSignal }): Promise<{
		aborted: boolean;
		errors: ReadonlyMap<string, Error>;
	}>;
}

export interface CatalogRefreshReport {
	stale: boolean;
	notice?: string;
}

export interface CatalogRefreshCoordinatorOptions {
	timeoutMs?: number;
	successTtlMs?: number;
	failureTtlMs?: number;
	now?: () => number;
}

const DEFAULT_REFRESH_TIMEOUT_MS = 5_000;
const DEFAULT_SUCCESS_TTL_MS = 15 * 60_000;
const DEFAULT_FAILURE_TTL_MS = 30_000;

export function mergeModelPolicy(agent: ModelPolicy, launch: ModelPolicy = {}, item: ModelPolicy = {}): ResolvedPolicy {
	const merged: ResolvedPolicy = { sources: {} };
	for (const key of ["model", "thinking", "provider", "family"] as const) {
		const entries = [
			{ value: item[key], source: "item" as const },
			{ value: launch[key], source: "launch" as const },
			{ value: agent[key], source: "agent" as const },
		];
		const selected = entries.find((entry) => entry.value !== undefined);
		if (selected) {
			merged[key] = selected.value;
			merged.sources[key] = selected.source;
		}
	}
	return merged;
}

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.match(/[a-z]+|\d+(?:\.\d+)?[a-z]?/g) ?? [];
}

function containsTokenSequence(haystack: readonly string[], needle: readonly string[]): boolean {
	if (needle.length === 0) return false;
	for (let start = 0; start <= haystack.length - needle.length; start++) {
		if (needle.every((token, offset) => haystack[start + offset] === token)) return true;
	}
	return false;
}

export function matchesFamily(model: CatalogModel, family: string): boolean {
	const wanted = tokenize(family);
	const identity = tokenize(`${model.id} ${model.name ?? ""}`);
	return containsTokenSequence(identity, wanted);
}

// Version-free naming heuristic, not a benchmark. Known series survive release
// codenames and vendor path aliases; product tiers remain separate series.
function seriesTokens(model: CatalogModel): string[] {
	const tokens = tokenize(model.id);
	const start = tokens.findIndex((token) => ["gpt", "claude", "gemini", "grok"].includes(token));
	return start < 0 ? tokens : tokens.slice(start);
}

function knownSeries(model: CatalogModel): { key: string; band: QualityBand } | undefined {
	const tokens = seriesTokens(model);
	const has = (token: string) => tokens.includes(token);
	const mainline = (name: string) => {
		const index = tokens.indexOf(name);
		return index >= 0 && /^\d/.test(tokens[index + 1] ?? "");
	};
	if (mainline("gpt")) {
		const tiers = ["nano", "mini", "codex", "pro"].filter(has);
		return { key: ["gpt", ...tiers].join("-"), band: has("nano") || has("mini") ? 1 : has("codex") ? 2 : 3 };
	}
	if (has("claude")) {
		for (const [tier, band] of [["haiku", 1], ["sonnet", 2], ["opus", 3]] as const) {
			if (has(tier)) return { key: `claude-${tier}`, band };
		}
	}
	if (mainline("gemini")) {
		const tiers = ["flash", "lite", "pro", "ultra"].filter(has);
		return { key: ["gemini", ...tiers].join("-"), band: has("flash") || has("lite") ? 1 : 3 };
	}
	if (mainline("grok")) {
		const tiers = ["mini", "fast", "code", "heavy"].filter(has);
		return { key: ["grok", ...tiers].join("-"), band: has("mini") || has("fast") ? 1 : has("code") ? 2 : 3 };
	}
	return undefined;
}

function modelFamilyKey(model: CatalogModel): string {
	const known = knownSeries(model);
	if (known) return known.key;
	const ignored = new Set(["latest", "preview", "experimental"]);
	const family = tokenize(model.id).filter((token) => {
		if (ignored.has(token)) return false;
		if (/^\d/.test(token)) return false;
		if (/^v$/.test(token)) return false;
		return true;
	});
	return family.join("-") || tokenize(model.id)[0] || model.id.toLowerCase();
}

function releaseParts(model: CatalogModel): number[] {
	const parts: number[] = [];
	for (const token of seriesTokens(model)) {
		if (/^\d{4,}$/.test(token)) break; // Dates and unlabelled large sizes are not releases.
		if (/^\d+(?:\.\d+)?[bkm]$/.test(token)) continue;
		if (!/^\d+(?:\.\d+)?$/.test(token)) {
			if (parts.length > 0) break;
			continue;
		}
		parts.push(...token.split(".").map(Number));
	}
	return parts.slice(0, 4);
}

function compareRelease(left: CatalogModel, right: CatalogModel): number {
	const a = releaseParts(left);
	const b = releaseParts(right);
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (b[index] ?? 0) - (a[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

type QualityBand = 1 | 2 | 3;

function qualityBand(model: CatalogModel): QualityBand | undefined {
	const known = knownSeries(model);
	if (known) return known.band;
	const tokens = new Set(tokenize(`${model.id} ${model.name ?? ""}`));
	if (["nano", "mini", "flash", "haiku", "small", "lite", "fast"].some((token) => tokens.has(token))) return 1;
	if (["opus", "ultra", "flagship", "large", "premier"].some((token) => tokens.has(token))) return 3;
	if (["sonnet", "codex", "coder", "code"].some((token) => tokens.has(token))) return 2;
	return undefined;
}

function suitabilityPenalty(policy: AutoPolicy, band: QualityBand | undefined): number {
	// Unknown families remain eligible, behind a recognized fit but ahead of
	// clearly mismatched tiers. Do not rank unknown names alphabetically as peers.
	if (band === undefined) return 1;
	const target: QualityBand = policy === "cheap" ? 1 : policy === "balanced" ? 2 : 3;
	return Math.abs(target - band) * 2;
}

function knownCost(model: CatalogModel): number | undefined {
	const values = [model.cost?.input, model.cost?.output, model.cost?.cacheRead, model.cost?.cacheWrite];
	if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return undefined;
	return values[0]! + values[1]! * 2 + values[2]! + values[3]!;
}

function thinkingIndex(level: ThinkingLevel): number {
	return THINKING_LEVELS.indexOf(level);
}

function validateThinking(value: string | undefined, fallback: string | undefined): ThinkingLevel {
	const selected = value ?? fallback ?? "off";
	if (!(THINKING_LEVELS as readonly string[]).includes(selected)) {
		throw new Error(`Invalid thinking level "${selected}". Expected: ${THINKING_LEVELS.join(", ")}`);
	}
	return selected as ThinkingLevel;
}

function validateConstraint(name: "provider" | "family", value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!value.trim() || value !== value.trim()) throw new Error(`Invalid ${name} constraint: ${JSON.stringify(value)}`);
	return value;
}

function parseModelPolicy(value: string): { kind: "auto"; policy: AutoPolicy } | {
	kind: "pinned";
	provider: string;
	modelId: string;
	thinking?: ThinkingLevel;
} {
	if (value.startsWith("auto:")) {
		const policy = value.slice("auto:".length);
		if (!(AUTO_POLICIES as readonly string[]).includes(policy)) {
			throw new Error(`Invalid automatic model policy "${value}". Expected: ${AUTO_POLICIES.map((item) => `auto:${item}`).join(", ")}`);
		}
		return { kind: "auto", policy: policy as AutoPolicy };
	}
	if (value === "auto" || value.trim() !== value || /\s/.test(value)) {
		throw new Error(`Malformed model policy "${value}"`);
	}
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw new Error(`Malformed pinned model "${value}". Expected provider/model[:thinking]`);
	}
	const provider = value.slice(0, slash);
	let modelId = value.slice(slash + 1);
	let thinking: ThinkingLevel | undefined;
	const colon = modelId.lastIndexOf(":");
	if (colon === modelId.length - 1) throw new Error(`Malformed pinned model "${value}"`);
	if (colon > 0) {
		const suffix = modelId.slice(colon + 1);
		if ((THINKING_LEVELS as readonly string[]).includes(suffix)) {
			thinking = suffix as ThinkingLevel;
			modelId = modelId.slice(0, colon);
		}
	}
	return { kind: "pinned", provider, modelId, thinking };
}

function catalogSuffix(notice: string | undefined): string {
	return notice ? `; ${notice}` : "";
}

function describeCost(model: CatalogModel): string {
	const cost = knownCost(model);
	return cost === undefined ? "catalog price unknown" : cost === 0 ? "catalog price is zero" : `relative catalog cost ${cost}`;
}

export function resolveModelSelection<TModel extends CatalogModel>(
	options: SelectionOptions<TModel>,
): Promise<SelectionResult<TModel>> {
	return waitWithDeadline(async (signal) => selectModel({ ...options, signal }), {
		signal: options.signal,
		timeoutMs: options.timeoutMs,
		label: "Model selection/authentication",
	});
}

async function selectModel<TModel extends CatalogModel>(
	options: SelectionOptions<TModel>,
): Promise<SelectionResult<TModel>> {
	const authenticate = async (model: TModel) => {
		options.signal?.throwIfAborted();
		const auth = await options.authenticate(model);
		options.signal?.throwIfAborted();
		return auth;
	};
	const provider = validateConstraint("provider", options.policy.provider);
	const family = validateConstraint("family", options.policy.family);
	const modelPolicy = options.policy.model;
	const effectiveThinking = (model: TModel, requested: ThinkingLevel): ThinkingLevel => {
		const levels = options.getSupportedThinkingLevels(model);
		const clamped = options.clampThinkingLevel(model, requested);
		return levels.includes(clamped) ? clamped : levels[0] ?? "off";
	};

	if (modelPolicy === undefined) {
		if (!options.parentModel) throw new Error("Agent has no model policy and the parent session has no model selected");
		if (provider && options.parentModel.provider !== provider) {
			throw new Error(`Inherited parent model ${options.parentModel.provider}/${options.parentModel.id} does not match provider constraint "${provider}"`);
		}
		if (family && !matchesFamily(options.parentModel, family)) {
			throw new Error(`Inherited parent model ${options.parentModel.provider}/${options.parentModel.id} does not match family constraint "${family}"`);
		}
		const requested = validateThinking(options.policy.thinking, options.parentThinkingLevel);
		const effective = effectiveThinking(options.parentModel, requested);
		const clamped = effective === requested ? "" : `; thinking ${requested} clamped to ${effective}`;
		return {
			model: options.parentModel,
			requestedThinkingLevel: requested,
			thinkingLevel: effective,
			reason: `inherited parent model because this agent has no model policy${clamped}${catalogSuffix(options.catalogNotice)}`,
		};
	}

	const parsed = parseModelPolicy(modelPolicy);
	if (parsed.kind === "pinned") {
		const model = options.allModels.find((candidate) => candidate.provider === parsed.provider && candidate.id === parsed.modelId);
		if (!model) throw new Error(`Pinned model is unavailable: ${parsed.provider}/${parsed.modelId}${catalogSuffix(options.catalogNotice)}`);
		if (provider && model.provider !== provider) throw new Error(`Pinned model does not match provider constraint "${provider}"`);
		if (family && !matchesFamily(model, family)) throw new Error(`Pinned model does not match family constraint "${family}"`);
		const auth = await authenticate(model);
		if (!auth.ok) {
			throw new Error(`Pinned model authentication is unavailable: ${model.provider}/${model.id}: ${auth.error}${catalogSuffix(options.catalogNotice)}`);
		}
		const requested = validateThinking(options.policy.thinking, parsed.thinking ?? options.parentThinkingLevel);
		const effective = effectiveThinking(model, requested);
		const clamped = effective === requested ? "" : `; thinking ${requested} clamped to ${effective}`;
		return {
			model,
			requestedThinkingLevel: requested,
			thinkingLevel: effective,
			reason: `used explicit model pin${clamped}${catalogSuffix(options.catalogNotice)}`,
		};
	}

	const requested = validateThinking(options.policy.thinking, options.parentThinkingLevel);
	const constrained = options.availableModels.filter((model) =>
		(!provider || model.provider === provider) && (!family || matchesFamily(model, family)),
	);
	if (constrained.length === 0) {
		const constraints = [provider ? `provider=${provider}` : "", family ? `family=${family}` : ""].filter(Boolean).join(", ");
		throw new Error(`No available models match auto:${parsed.policy}${constraints ? ` (${constraints})` : ""}${catalogSuffix(options.catalogNotice)}`);
	}

	const recencyRank = new Map<TModel, number>();
	const families = new Map<string, TModel[]>();
	for (const model of constrained) {
		const key = modelFamilyKey(model);
		const entries = families.get(key) ?? [];
		entries.push(model);
		families.set(key, entries);
	}
	for (const entries of families.values()) {
		entries.sort(compareRelease);
		let rank = 0;
		entries.forEach((model, index) => {
			if (index > 0 && compareRelease(entries[index - 1], model) !== 0) rank++;
			recencyRank.set(model, rank);
		});
	}

	const candidates = [...constrained].sort((left, right) => {
		const suitability = suitabilityPenalty(parsed.policy, qualityBand(left)) - suitabilityPenalty(parsed.policy, qualityBand(right));
		if (suitability !== 0) return suitability;
		if (options.policy.thinking !== undefined || options.parentThinkingLevel !== undefined) {
			const leftThinking = effectiveThinking(left, requested);
			const rightThinking = effectiveThinking(right, requested);
			const thinkingFit = Math.abs(thinkingIndex(requested) - thinkingIndex(leftThinking))
				- Math.abs(thinkingIndex(requested) - thinkingIndex(rightThinking));
			if (thinkingFit !== 0) return thinkingFit;
		}
		const recency = (recencyRank.get(left) ?? 0) - (recencyRank.get(right) ?? 0);
		if (recency !== 0) return recency;
		const leftCost = knownCost(left);
		const rightCost = knownCost(right);
		if (leftCost !== undefined || rightCost !== undefined) {
			if (leftCost === undefined) return 1;
			if (rightCost === undefined) return -1;
			if (leftCost !== rightCost) return leftCost - rightCost;
		}
		return `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`);
	});

	const rejected: string[] = [];
	for (const model of candidates) {
		const auth = await authenticate(model);
		if (!auth.ok) {
			rejected.push(`${model.provider}/${model.id}: ${auth.error}`);
			continue;
		}
		const effective = effectiveThinking(model, requested);
		const targetBand = parsed.policy === "cheap" ? 1 : parsed.policy === "balanced" ? 2 : 3;
		const fit = qualityBand(model) === targetBand ? `${parsed.policy} fit` : `${parsed.policy} fallback`;
		const constraints = [provider ? `provider ${provider}` : "", family ? `family ${family}` : ""].filter(Boolean);
		const details = [fit, "latest release ranked only within comparable families", describeCost(model), ...constraints];
		if (effective !== requested) details.push(`thinking ${requested} clamped to ${effective}`);
		if (rejected.length > 0) details.push(`skipped ${rejected.length} unauthenticated candidate${rejected.length === 1 ? "" : "s"}`);
		return {
			model,
			requestedThinkingLevel: requested,
			thinkingLevel: effective,
			reason: `auto:${parsed.policy}: ${details.join(", ")}${catalogSuffix(options.catalogNotice)}`,
		};
	}

	throw new Error(`No authenticated models remain for auto:${parsed.policy}; ${rejected.join("; ")}${catalogSuffix(options.catalogNotice)}`);
}

// Bounds the caller even when an SDK facade cannot pass cancellation through.
// Both handlers stay attached to the work promise to consume late rejection.
export function waitWithDeadline<T>(
	work: (signal: AbortSignal) => Promise<T>,
	options: { signal?: AbortSignal; timeoutMs?: number; label: string },
): Promise<T> {
	const controller = new AbortController();
	const timeoutMs = options.timeoutMs ?? 10_000;
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const cancel = (error: Error) => {
			controller.abort(error);
			cleanup();
			reject(error);
		};
		const onAbort = () => cancel(abortError(`${options.label} aborted`));
		const timeout = setTimeout(() => cancel(new Error(`${options.label} timed out after ${timeoutMs}ms`)), timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) { onAbort(); return; }
		Promise.resolve().then(() => {
			controller.signal.throwIfAborted();
			return work(controller.signal);
		}).then(
			(value) => { cleanup(); resolve(value); },
			(error) => { cleanup(); reject(error); },
		);
	});
}

function abortError(message = "Catalog refresh aborted"): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

export class CatalogRefreshCoordinator {
	private readonly timeoutMs: number;
	private readonly successTtlMs: number;
	private readonly failureTtlMs: number;
	private readonly now: () => number;
	private inFlight?: Promise<CatalogRefreshReport>;
	private cached?: { at: number; report: CatalogRefreshReport };

	constructor(options: CatalogRefreshCoordinatorOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
		this.successTtlMs = options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS;
		this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
		this.now = options.now ?? Date.now;
	}

	async refresh(registry: CatalogRefreshRegistry, allowNetwork: boolean, signal?: AbortSignal): Promise<CatalogRefreshReport> {
		if (signal?.aborted) throw abortError();
		const ttl = this.cached?.report.stale ? this.failureTtlMs : this.successTtlMs;
		if (this.cached && this.now() - this.cached.at < ttl) return this.cached.report;
		if (this.inFlight) return this.waitForCaller(this.inFlight, signal);

		const timeoutController = new AbortController();
		let timeout: ReturnType<typeof setTimeout>;
		const timedOut = new Promise<undefined>((resolve) => {
			timeout = setTimeout(() => {
				timeoutController.abort();
				resolve(undefined);
			}, this.timeoutMs);
		});
		this.inFlight = (async () => {
			try {
				const refresh = Promise.resolve().then(() => registry.refresh({ allowNetwork, signal: timeoutController.signal }));
				const result = await Promise.race([refresh, timedOut]);
				if (!result) {
					const report = {
						stale: true,
						notice: `catalog may be stale (catalog refresh timed out after ${this.timeoutMs}ms)`,
					};
					this.cached = { at: this.now(), report };
					return report;
				}
				const errors = [...result.errors].map(([provider, error]) => `${provider}: ${error.message}`);
				const registryError = registry.getError?.()?.trim();
				if (registryError) errors.push(registryError);
				if (result.aborted) errors.unshift("catalog refresh was aborted before all providers completed");
				const report: CatalogRefreshReport = errors.length > 0
					? { stale: true, notice: `catalog may be stale (${errors.join("; ")})` }
					: { stale: false };
				this.cached = { at: this.now(), report };
				return report;
			} catch (error) {
				const message = timeoutController.signal.aborted
					? `catalog refresh timed out after ${this.timeoutMs}ms`
					: `catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`;
				const report = { stale: true, notice: `catalog may be stale (${message})` };
				this.cached = { at: this.now(), report };
				return report;
			} finally {
				clearTimeout(timeout!);
				this.inFlight = undefined;
			}
		})();
		return this.waitForCaller(this.inFlight, signal);
	}

	private waitForCaller(promise: Promise<CatalogRefreshReport>, signal?: AbortSignal): Promise<CatalogRefreshReport> {
		if (!signal) return promise;
		return new Promise((resolve, reject) => {
			const onAbort = () => reject(abortError());
			const cleanup = () => signal.removeEventListener("abort", onAbort);
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(
				(value) => { cleanup(); resolve(value); },
				(error) => { cleanup(); reject(error); },
			);
			if (signal.aborted) { cleanup(); onAbort(); }
		});
	}
}
