import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import {
	CatalogRefreshCoordinator,
	THINKING_LEVELS,
	matchesFamily,
	mergeModelPolicy,
	resolveModelSelection,
	type CatalogModel,
	type ModelPolicy,
	type ThinkingLevel,
} from "../extensions/lib/model-selection.ts";

function model(
	provider: string,
	id: string,
	options: Partial<CatalogModel> = {},
): CatalogModel {
	return {
		provider,
		id,
		name: id,
		reasoning: true,
		cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
		...options,
	};
}

function supported(candidate: CatalogModel): ThinkingLevel[] {
	if (!candidate.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = candidate.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function clamp(candidate: CatalogModel, requested: ThinkingLevel): ThinkingLevel {
	const levels = supported(candidate);
	if (levels.includes(requested)) return requested;
	const index = THINKING_LEVELS.indexOf(requested);
	for (let current = index; current < THINKING_LEVELS.length; current++) {
		if (levels.includes(THINKING_LEVELS[current])) return THINKING_LEVELS[current];
	}
	for (let current = index - 1; current >= 0; current--) {
		if (levels.includes(THINKING_LEVELS[current])) return THINKING_LEVELS[current];
	}
	return "off";
}

async function select(
	policy: ModelPolicy,
	availableModels: CatalogModel[],
	options: {
		allModels?: CatalogModel[];
		parentModel?: CatalogModel;
		parentThinkingLevel?: string;
		auth?: (candidate: CatalogModel) => Promise<{ ok: true } | { ok: false; error: string }>;
		catalogNotice?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
	} = {},
) {
	return resolveModelSelection({
		policy,
		availableModels,
		allModels: options.allModels ?? availableModels,
		parentModel: options.parentModel,
		parentThinkingLevel: options.parentThinkingLevel,
		authenticate: options.auth ?? (async () => ({ ok: true })),
		getSupportedThinkingLevels: supported,
		clampThinkingLevel: clamp,
		catalogNotice: options.catalogNotice,
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
}

test("automatic policies choose suitable models across providers", async () => {
	const catalog = [
		model("openrouter", "gpt-5.9-mini-20251231", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		model("native-header", "gpt-5.10-mini-20240101", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
		model("custom-keyless", "novel-code-2", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		model("anthropic", "claude-opus-5", { thinkingLevelMap: { max: "max" }, cost: { input: 5, output: 25, cacheRead: 1, cacheWrite: 6 } }),
	];

	assert.equal((await select({ model: "auto:cheap", thinking: "low" }, catalog)).model.id, "gpt-5.10-mini-20240101");
	assert.equal((await select({ model: "auto:balanced", thinking: "medium" }, catalog)).model.id, "novel-code-2");
	assert.equal((await select({ model: "auto:strong", thinking: "max" }, catalog)).model.id, "claude-opus-5");
});

test("zero is a known price and missing or invalid prices are unknown", async () => {
	const zero = model("subscription", "swift-flash", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	const missing = model("custom", "rapid-mini", { cost: undefined });
	const invalid = model("other", "quick-haiku", { cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } });
	const result = await select({ model: "auto:cheap", thinking: "low" }, [missing, invalid, zero]);
	assert.equal(result.model, zero);
	assert.match(result.reason, /catalog price is zero/);
});

test("release ordering compares numeric components only inside a family", async () => {
	const olderDate = model("a", "gpt-5.10-mini-20240101");
	const newerDate = model("b", "gpt-5.9-mini-20261231");
	assert.equal((await select({ model: "auto:cheap" }, [newerDate, olderDate])).model, olderDate);

	const largerOld = model("a", "acme-2-70b");
	const smallerNew = model("a", "acme-3-8b");
	assert.equal((await select({ model: "auto:balanced" }, [largerOld, smallerNew])).model, smallerNew);
});

test("equal releases across providers and date aliases use price before provider name", async () => {
	for (const [paidId, cheaperId] of [
		["gpt-5-mini", "gpt-5-mini"],
		["gpt-5-mini-20261231", "gpt-5-mini-20240101"],
		["gpt-5.0-mini-20261231", "gpt-5-mini"],
	]) {
		for (const price of [0, 1]) {
			const paid = model("aaa-paid", paidId, { cost: { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 } });
			const cheaper = model("zzz-free", cheaperId, { cost: { input: price, output: price, cacheRead: price, cacheWrite: price } });
			for (const catalog of [[paid, cheaper], [cheaper, paid]]) {
				assert.equal((await select({ model: "auto:cheap" }, catalog)).model, cheaper);
			}
		}
	}
});

test("family matching is normalized token-sequence based and provider independent", async () => {
	const candidates = [
		model("gateway-one", "vendor/claude-opus-5", { thinkingLevelMap: { max: "max" } }),
		model("gateway-two", "gpt-6-astra", { thinkingLevelMap: { max: "max" } }),
		model("gateway-three", "grok-4.6", { thinkingLevelMap: { max: "max" } }),
	];
	assert.equal(matchesFamily(candidates[0], "Claude Opus"), true);
	assert.equal((await select({ model: "auto:strong", family: "claude-opus", thinking: "max" }, candidates)).model.provider, "gateway-one");
	assert.equal((await select({ model: "auto:strong", family: "gpt", thinking: "max" }, candidates)).model.provider, "gateway-two");
	assert.equal((await select({ model: "auto:strong", family: "grok", thinking: "max" }, candidates)).model.provider, "gateway-three");
});

test("single, parallel, and chain policy precedence is item then launch then agent", () => {
	const agent = { model: "auto:cheap", thinking: "low", provider: "agent-provider", family: "agent-family" };
	const launch = { model: "auto:balanced", thinking: "medium", provider: "launch-provider" };
	const item = { model: "auto:strong", thinking: "high", family: "item-family" };
	for (const _mode of ["single", "parallel", "chain"]) {
		assert.deepEqual(mergeModelPolicy(agent, launch, item), {
			model: "auto:strong",
			thinking: "high",
			provider: "launch-provider",
			family: "item-family",
			sources: { model: "item", thinking: "item", provider: "launch", family: "item" },
		});
	}
});

test("pins, inheritance, malformed specs, and missing models are explicit", async () => {
	const parent = model("parent", "parent-model", { reasoning: false });
	const pinned = model("custom", "model:8b", { reasoning: false });
	const inherited = await select({}, [pinned], { parentModel: parent, parentThinkingLevel: "high" });
	assert.equal(inherited.model, parent);
	assert.equal(inherited.thinkingLevel, "off");
	assert.match(inherited.reason, /inherited parent model/);

	assert.equal((await select({ model: "custom/model:8b", thinking: "off" }, [pinned])).model, pinned);
	await assert.rejects(select({ model: "model-without-provider" }, [pinned]), /Malformed pinned model/);
	await assert.rejects(select({ model: "auto:quick" }, [pinned]), /Invalid automatic model policy/);
	await assert.rejects(select({ model: "custom/missing" }, [pinned]), /Pinned model is unavailable/);
});

test("empty explicit models reject instead of inheriting or bypassing agent defaults", async () => {
	const parent = model("parent", "parent-model");
	await assert.rejects(select({ model: "" }, [parent], { parentModel: parent }), /Malformed pinned model/);
	const merged = mergeModelPolicy({ model: "auto:cheap" }, { model: "" });
	assert.equal(merged.model, "");
	assert.equal(merged.sources.model, "launch");
	await assert.rejects(select(merged, [parent], { parentModel: parent }), /Malformed pinned model/);
});

test("authentication retries stay within automatic constraints and pins never fall back", async () => {
	const latest = model("one", "gpt-5.10");
	const older = model("two", "gpt-5.9");
	const outside = model("three", "claude-opus-5");
	const attempted: string[] = [];
	const auth = async (candidate: CatalogModel) => {
		attempted.push(candidate.id);
		return candidate === latest ? { ok: false as const, error: "expired" } : { ok: true as const };
	};
	const result = await select({ model: "auto:strong", family: "gpt" }, [outside, older, latest], { auth });
	assert.equal(result.model, older);
	assert.deepEqual(attempted, ["gpt-5.10", "gpt-5.9"]);
	assert.match(result.reason, /skipped 1 unauthenticated candidate/);

	await assert.rejects(
		select({ model: "one/gpt-5.10" }, [older], { allModels: [latest, older], auth }),
		/Pinned model authentication is unavailable/,
	);
});

test("thinking uses supported levels, max clamps, and non-reasoning becomes off", async () => {
	const maxModel = model("custom", "reasoner", { thinkingLevelMap: { xhigh: null, max: "max" } });
	assert.equal((await select({ model: "custom/reasoner", thinking: "max" }, [maxModel])).thinkingLevel, "max");
	assert.equal((await select({ model: "custom/reasoner:low", thinking: "max" }, [maxModel])).thinkingLevel, "max");

	const highOnly = model("custom", "high-only", { thinkingLevelMap: { xhigh: null, max: null } });
	const clamped = await select({ model: "custom/high-only", thinking: "max" }, [highOnly]);
	assert.equal(clamped.thinkingLevel, "high");
	assert.match(clamped.reason, /clamped to high/);

	const plain = model("custom", "plain", { reasoning: false });
	assert.equal((await select({ model: "custom/plain", thinking: "high" }, [plain])).thinkingLevel, "off");
});

test("catalog refresh deduplicates calls and honors success TTL", async () => {
	let now = 1_000;
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const registry = {
		async refresh() {
			calls++;
			await gate;
			return { aborted: false, errors: new Map<string, Error>() };
		},
	};
	const coordinator = new CatalogRefreshCoordinator({ now: () => now, successTtlMs: 100, failureTtlMs: 10, timeoutMs: 1_000 });
	const first = coordinator.refresh(registry, true);
	const second = coordinator.refresh(registry, true);
	release();
	assert.deepEqual(await Promise.all([first, second]), [{ stale: false }, { stale: false }]);
	assert.equal(calls, 1);
	await coordinator.refresh(registry, true);
	assert.equal(calls, 1);
	now += 101;
	await coordinator.refresh(registry, true);
	assert.equal(calls, 2);
});

test("returned refresh errors are stale warnings and use the short TTL", async () => {
	let now = 0;
	let calls = 0;
	const registry = {
		async refresh() {
			calls++;
			return { aborted: false, errors: new Map([["dynamic", new Error("service unavailable")]]) };
		},
	};
	const coordinator = new CatalogRefreshCoordinator({ now: () => now, successTtlMs: 100, failureTtlMs: 10 });
	const report = await coordinator.refresh(registry, true);
	assert.equal(report.stale, true);
	assert.match(report.notice!, /dynamic: service unavailable/);
	now += 11;
	await coordinator.refresh(registry, true);
	assert.equal(calls, 2);
});

test("catalog refresh timeout bounds an uncooperative registry", async () => {
	let underlyingSignal!: AbortSignal;
	let rejectRefresh!: (error: Error) => void;
	const hangingRegistry = {
		refresh(options: { signal: AbortSignal }) {
			underlyingSignal = options.signal;
			return new Promise<{ aborted: boolean; errors: Map<string, Error> }>((_resolve, reject) => { rejectRefresh = reject; });
		},
	};
	const coordinator = new CatalogRefreshCoordinator({ timeoutMs: 5 });
	const timed = await coordinator.refresh(hangingRegistry, true);
	assert.equal(timed.stale, true);
	assert.match(timed.notice!, /timed out/);
	assert.equal(underlyingSignal.aborted, true);
	rejectRefresh(new Error("late registry rejection"));
	assert.equal(await coordinator.refresh(hangingRegistry, true), timed);
});

for (const cancelledIndex of [0, 1]) {
	test(`catalog refresh isolates ${cancelledIndex === 0 ? "initiating" : "joining"} caller cancellation`, async () => {
		let calls = 0;
		let underlyingSignal!: AbortSignal;
		let release!: () => void;
		let markStarted!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const registry = {
			async refresh(options: { signal: AbortSignal }) {
				calls++;
				underlyingSignal = options.signal;
				markStarted();
				await gate;
				return { aborted: false, errors: new Map<string, Error>() };
			},
		};
		const coordinator = new CatalogRefreshCoordinator({ timeoutMs: 1_000 });
		const controllers = [new AbortController(), new AbortController()];
		const waits = controllers.map((controller) => coordinator.refresh(registry, true, controller.signal));
		const outcomes = Promise.allSettled(waits);
		await started;
		controllers[cancelledIndex].abort();
		try {
			await assert.rejects(waits[cancelledIndex], { name: "AbortError" });
			assert.equal(underlyingSignal.aborted, false);
			assert.equal(getEventListeners(controllers[cancelledIndex].signal, "abort").length, 0);
			for (const controller of controllers) assert.notEqual(underlyingSignal, controller.signal);
		} finally {
			release();
		}
		await outcomes;
		assert.deepEqual(await waits[1 - cancelledIndex], { stale: false });
		assert.deepEqual(await coordinator.refresh(registry, true), { stale: false });
		assert.equal(calls, 1);
		for (const controller of controllers) assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.equal(getEventListeners(underlyingSignal, "abort").length, 0);
	});
}

test("mainline releases compare across codenames and non-Copilot vendor aliases", async () => {
	for (const price of [0, 1]) {
		const cost = { input: price, output: price, cacheRead: price, cacheWrite: price };
		const older = model("github-copilot", "gpt-5.6-sol", { cost });
		const newer = model("openrouter", "openai/gpt-6-astra", { cost });
		const next = model("custom-gateway", "vendor/gpt-7-aurora", { cost });
		for (const catalog of [[older, newer], [newer, older]]) {
			assert.equal((await select({ model: "auto:strong", family: "gpt" }, catalog)).model, newer);
			assert.equal((await select({ model: "auto:strong", family: "gpt" }, [...catalog, next])).model, next);
		}
	}
	const paid = model("aaa", "gpt-6-astra");
	const free = model("zzz", "openai/gpt-6-astra", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	assert.equal((await select({ model: "auto:strong" }, [paid, free])).model, free);
});

test("known strong and coding tiers outrank unrelated generic names without comparing their versions", async () => {
	const generic = model("aaa", "claude-fable-1");
	const codex = model("openai", "gpt-5.1-codex");
	const latest = model("gateway", "openai/gpt-6-astra");
	const sonnet = model("gateway", "anthropic/claude-sonnet-5");
	assert.equal((await select({ model: "auto:strong", family: "gpt" }, [codex, latest])).model, latest);
	for (const mid of [sonnet, codex]) {
		assert.equal((await select({ model: "auto:balanced" }, [generic, mid])).model, mid);
	}
	const opus = model("anthropic", "claude-opus-1", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	assert.equal((await select({ model: "auto:strong" }, [latest, opus])).model, opus);
	// Pro, mini, nano, and codex must not make the mainline look obsolete.
	for (const tier of ["pro", "mini", "nano", "codex"]) {
		const other = model("zzz", `gpt-99-${tier}`);
		assert.equal((await select({ model: "auto:strong", family: "gpt" }, [other, latest])).model, latest);
	}
});

test("generic-only catalogs remain eligible for every policy and respect constraints", async () => {
	const old = model("custom", "unfamiliar-2");
	const latest = model("custom", "unfamiliar-3");
	for (const policy of ["cheap", "balanced", "strong"]) {
		assert.equal((await select({ model: `auto:${policy}`, provider: "custom", family: "unfamiliar" }, [old, latest])).model, latest);
	}
});

test("an absent thinking preference does not prefer off-capable models", async () => {
	const older = model("openai", "gpt-5");
	const latest = model("openai", "gpt-6", { thinkingLevelMap: { off: null } });
	const result = await select({ model: "auto:strong" }, [older, latest]);
	assert.equal(result.model, latest);
	assert.equal(result.thinkingLevel, "minimal");
	assert.equal((await select({ model: "auto:strong", thinking: "off" }, [older, latest])).model, older);
	assert.equal((await select({ model: "auto:strong" }, [older, latest], { parentThinkingLevel: "off" })).model, older);
});

for (const policy of ["custom/gpt-6", "auto:strong"]) {
	test(`${policy} authentication has a total timeout and consumes late rejection`, async () => {
		const candidate = model("custom", "gpt-6");
		let rejectAuth!: (error: Error) => void;
		let calls = 0;
		const auth = () => {
			calls++;
			return new Promise<{ ok: true }>((_resolve, reject) => { rejectAuth = reject; });
		};
		await assert.rejects(select({ model: policy }, [candidate], { auth, timeoutMs: 5 }), /selection\/authentication timed out/);
		rejectAuth(new Error("late auth rejection"));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls, 1);
	});

	test(`${policy} caller cancellation cannot resume selection after late auth`, async () => {
		for (const ok of [true, false]) {
			const controller = new AbortController();
			let release!: (value: { ok: true } | { ok: false; error: string }) => void;
			let started!: () => void;
			const ready = new Promise<void>((resolve) => { started = resolve; });
			let calls = 0;
			const auth = () => {
				calls++;
				started();
				return new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => { release = resolve; });
			};
			const selection = select({ model: policy }, [model("custom", "gpt-6"), model("custom", "gpt-5")], {
				auth, signal: controller.signal, timeoutMs: 1_000,
			});
			await ready;
			controller.abort();
			await assert.rejects(selection, { name: "AbortError" });
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			release(ok ? { ok: true } : { ok: false, error: "expired" });
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(calls, 1);
		}
	});
}

test("authentication failures never cross provider or family constraints", async () => {
	const attempted: string[] = [];
	await assert.rejects(select({ model: "auto:strong", provider: "one", family: "gpt" }, [
		model("one", "gpt-6"), model("two", "gpt-7"), model("one", "claude-opus-5"),
	], { auth: async (candidate) => { attempted.push(candidate.id); return { ok: false, error: "expired" }; } }), /No authenticated models remain/);
	assert.deepEqual(attempted, ["gpt-6"]);
});

test("registry-level refresh errors produce stale notices and the short TTL", async () => {
	let now = 0;
	let calls = 0;
	const registry = {
		async refresh() { calls++; return { aborted: false, errors: new Map<string, Error>() }; },
		getError: () => "Availability refresh: auth check failed",
	};
	const coordinator = new CatalogRefreshCoordinator({ now: () => now, successTtlMs: 100, failureTtlMs: 10 });
	const report = await coordinator.refresh(registry, true);
	assert.equal(report.stale, true);
	assert.match(report.notice!, /auth check failed/);
	now = 11;
	await coordinator.refresh(registry, true);
	assert.equal(calls, 2);
});

test("vendor path numbers, context sizes, and parameter counts do not change release ranking", async () => {
	const old = model("a", "gateway-v99/gpt-5.6-sol-256k");
	const latest = model("b", "gateway-v1/openai/gpt-6-astra-32k");
	assert.equal((await select({ model: "auto:strong" }, [old, latest])).model, latest);
	const large = model("a", "acme-3-70b-128000");
	const small = model("b", "acme-3-8b-8192", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	assert.equal((await select({ model: "auto:balanced" }, [large, small])).model, small);
});

test("selection cleans up signals on success and does not authenticate a pre-cancelled caller", async () => {
	const controller = new AbortController();
	const candidate = model("one", "gpt-6");
	await select({ model: "one/gpt-6" }, [candidate], { signal: controller.signal });
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	controller.abort();
	await assert.rejects(select({ model: "auto:strong" }, [candidate], {
		signal: controller.signal,
		auth: async () => { assert.fail("Pre-cancelled selection must not authenticate"); },
	}), { name: "AbortError" });
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
