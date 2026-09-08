import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import * as selection from "../extensions/lib/model-selection.ts";

const source = await readFile(new URL("../extensions/subagent.ts", import.meta.url), "utf8");

function functionSource(name: string, nested = false): string {
	const indent = nested ? "\t" : "";
	const match = source.match(new RegExp(`^${indent}(?:async )?function ${name}\\b[\\s\\S]*?^${indent}\\}`, "m"));
	assert.ok(match, `Launcher must define ${name}`);
	return match[0];
}

test("slash commands retain literal flags, multiline tasks, and original prompt endings", async () => {
	const commands = new Map<string, any>();
	const messages: string[] = [];
	const pi = {
		registerCommand: (name: string, command: any) => commands.set(name, command),
		sendUserMessage: (message: string) => messages.push(message),
	};
	const slashCommands = source.slice(source.indexOf('\tpi.registerCommand("run",'), source.lastIndexOf("}"));
	new Function("pi", "discoverAgents", "agentCompletions", "findPlanFile", stripTypeScriptTypes(`
		${functionSource("parseQuotedArgs")}
		${slashCommands}
	`))(pi, () => ({ agents: [] }), () => [], () => undefined);
	const ctx = { cwd: "/test", ui: { notify: () => assert.fail("Unexpected usage message") } };
	const task = 'Keep "--model=literal" and "--provider=literal"\n  on separate lines';
	await commands.get("dispatch").handler(task, ctx);
	assert.ok(messages.pop()!.endsWith(`## Task\n${task}`));
	await commands.get("chain").handler(`scout -> coder -- ${task}`, ctx);
	assert.deepEqual(JSON.parse(messages.pop()!.split("with these steps: ")[1]), [
		{ agent: "scout", task }, { agent: "coder", task: "{previous}" },
	]);
	await commands.get("chain").handler('scout "literal --model=example" -> coder "literal --provider=example"', ctx);
	assert.deepEqual(JSON.parse(messages.pop()!.split("with these steps: ")[1]), [
		{ agent: "scout", task: "literal --model=example" }, { agent: "coder", task: "literal --provider=example" },
	]);
	// /run already joined whitespace in HEAD; retain that behavior, without new punctuation.
	await commands.get("run").handler(`coder ${task}`, ctx);
	assert.equal(messages.pop(), `Use the subagent tool to run agent "coder" with this task: ${task.split(/\s+/).join(" ")}`);
	assert.doesNotMatch(source, /extractSlashPolicy|policyInstruction/);
});

function launcher(
	auth = async (_candidate: any): Promise<any> => ({ ok: true }),
	agentPolicy: selection.ModelPolicy = { model: "auto:cheap", provider: "agent", family: "gpt", thinking: "low" },
) {
	const catalog = [
		{ provider: "agent", id: "gpt-5-mini", reasoning: true },
		{ provider: "launch", id: "gpt-6", reasoning: true },
		{ provider: "item", id: "claude-opus-5", reasoning: true },
	];
	const agents = [{ name: "coder", ...agentPolicy, tools: ["read"] }];
	const created: any[] = [];
	const refreshes: boolean[] = [];
	let error: string | undefined;
	const ctx = {
		cwd: "/test", model: catalog[0], thinkingLevel: "medium",
		scopedModels: [{ model: catalog[0] }],
		modelRegistry: {
			getAvailable: () => catalog, getAll: () => catalog, getError: () => error,
			getApiKeyAndHeaders: auth,
			refresh: async ({ allowNetwork }: any) => { refreshes.push(allowNetwork); return { aborted: false, errors: new Map() }; },
		},
	};
	// Exercise actual dispatch -> runAgent -> resolver wiring, replacing only
	// disk/UI/sandbox/session boundaries. A fake session cannot make model calls.
	const dependencies = {
		...selection, agents, ctx, MAX_PARALLEL: 8,
		getSupportedThinkingLevels: () => selection.THINKING_LEVELS,
		clampThinkingLevel: (_model: any, level: string) => level,
		catalogRefreshers: new WeakMap(),
		getGondolinToolProvider: () => ({ tools: [{ name: "read" }], hostCwd: "/test" }),
		resolveAuthoritativeCwd: () => "/test",
		childLimiter: { acquire: async () => () => {} },
		getChildModelRuntime: async () => ({}),
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class { async reload() {} },
		getAgentDir: () => "/unused",
		SessionManager: { inMemory: () => ({}) },
		createAgentSession: async (options: any) => {
			created.push(options);
			return { session: {
				model: options.model, thinkingLevel: options.thinkingLevel, isIdle: true,
				bindExtensions: async () => {}, subscribe: () => () => {}, dispose: () => {},
				prompt: async () => {},
			} };
		},
		getFinalOutput: () => "", truncateOutput: (text: string) => text,
	};
	const code = [
		...Object.keys(dependencies).map((name) => `const ${name} = dependencies.${name};`),
		...["emptyUsage", "isFailedResult", "isTerminalResult", "refreshModelCatalog", "shutdownChildSession", "runAgent"].map((name) => functionSource(name)),
		...["modelPolicyFrom", "makePlaceholder", "executeDispatch"].map((name) => functionSource(name, true)),
	].join("\n");
	const dispatch = new Function("dependencies", `${stripTypeScriptTypes(code)}
		return (params, signal) => executeDispatch(params, signal, undefined, undefined, undefined, undefined, ctx, agents);
	`)(dependencies);
	return { dispatch, created, refreshes, catalog, setError: (value: string) => { error = value; } };
}

test("actual launcher wires agent, single/shared launch, parallel item, and chain step policies", async () => {
	const shared = { model: "launch/gpt-6", provider: "launch", thinking: "high", family: "gpt" };
	const item = { model: "item/claude-opus-5", provider: "item", thinking: "max", family: "claude-opus" };
	for (const mode of ["single", "parallel", "chain"]) {
		const run = launcher();
		const tasks = [{ agent: "coder", task: "first" }, { agent: "coder", task: "second", ...item }];
		const result = await run.dispatch({ ...shared, ...(mode === "single" ? tasks[0] : { [mode === "parallel" ? "tasks" : "chain"]: tasks }) });
		assert.equal(result.isError, undefined);
		assert.deepEqual(run.created.map((options) => options.model.provider), mode === "single" ? ["launch"] : ["launch", "item"]);
		assert.deepEqual(run.created.map((options) => options.thinkingLevel), mode === "single" ? ["high"] : ["high", "max"]);
		assert.match(result.details.results[0].selectionReason, /model from launch/);
		if (mode !== "single") assert.match(result.details.results[1].selectionReason, /model from item/);
		assert.deepEqual(run.refreshes, []);
	}
	const defaults = launcher();
	const result = await defaults.dispatch({ agent: "coder", task: "defaults" });
	assert.equal(result.isError, undefined);
	assert.equal(defaults.created[0].model.provider, "agent");
	assert.equal(defaults.created[0].thinkingLevel, "low");
});

test("launcher refreshes only automatic discovery, and an empty PI_OFFLINE value is online", async () => {
	const offline = process.env.PI_OFFLINE;
	try {
		for (const value of [undefined, "", "1"]) {
			if (value === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = value;
			const run = launcher();
			await run.dispatch({ agent: "coder", task: "auto" });
			assert.deepEqual(run.refreshes, [!value]);
		}
	} finally {
		if (offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = offline;
	}
	const run = launcher();
	run.setError("test stale catalog");
	const missing = await run.dispatch({ agent: "coder", task: "pin", model: "agent/missing" });
	assert.equal(missing.isError, true);
	assert.match(missing.content[0].text, /Pinned model is unavailable.*catalog may be stale/);
	assert.deepEqual(run.refreshes, []);
	const inherited = launcher(undefined, {});
	const result = await inherited.dispatch({ agent: "coder", task: "inherit" });
	assert.equal(result.isError, undefined);
	assert.deepEqual(inherited.refreshes, []);
	assert.match(result.details.results[0].selectionReason, /inherited parent model/);
});

for (const model of ["agent/gpt-5-mini", "auto:cheap"]) {
	test(`launcher cancellation during ${model} auth never creates a session after late resolution`, async () => {
		let started!: () => void;
		const ready = new Promise<void>((resolve) => { started = resolve; });
		let release!: (value: any) => void;
		const run = launcher(() => { started(); return new Promise((resolve) => { release = resolve; }); });
		const controller = new AbortController();
		const execution = run.dispatch({ agent: "coder", task: "cancel", model }, controller.signal);
		await ready;
		controller.abort();
		const result = await execution;
		assert.equal(result.details.results[0].state, "aborted");
		release({ ok: true });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(run.created, []);
	});
}
