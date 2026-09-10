import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fakeChildSession, inspector } from "./helpers/subagent-inspector.ts";
import * as selection from "../extensions/lib/model-selection.ts";

const source = await readFile(new URL("../extensions/subagent.ts", import.meta.url), "utf8");

function functionSource(name: string, nested = false): string {
	const indent = nested ? "\t" : "";
	const match = source.match(new RegExp(`^${indent}(?:async )?function ${name}\\b[\\s\\S]*?^${indent}\\}`, "m"));
	assert.ok(match, `Launcher must define ${name}`);
	return match[0];
}

function constSource(name: string): string {
	const match = source.match(new RegExp(`^const ${name} = [^;]+;`, "m"));
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
		sessionManager: { getSessionId: () => "owner", getSessionFile: () => "/tmp/owner.jsonl" },
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
		...inspector,
		createChildSession: fakeChildSession,
		fs: { existsSync: () => false },
		...selection, agents, ctx, MAX_PARALLEL: 8,
		heuristicSessionName: (text: string) => text.split(/\n/).map((line) => line.trim()).find(Boolean) ?? "Subagent Task",
		waitWithDeadline: async (operation: any, options: any) => operation(options?.signal),
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
		createAgentSession: async (options: any) => {
			created.push(options);
			return { session: {
				model: options.model, thinkingLevel: options.thinkingLevel, isIdle: true,
				bindExtensions: async () => {}, subscribe: () => () => {}, dispose: () => {},
				setSessionName: () => {},
				prompt: async () => {},
			} };
		},
		getFinalOutput: () => "", truncateOutput: (text: string) => text,
	};
	const code = [
		...Object.keys(dependencies).map((name) => `const ${name} = dependencies.${name};`),
		constSource("TITLE_MAX_WORDS"),
		constSource("TITLE_MAX_CHARS"),
		constSource("TITLE_PROMPT_CHARS"),
		constSource("TITLE_TIMEOUT_MS"),
		"const cleanGeneratedSessionName = (value) => value;",
		...["emptyUsage", "isFailedResult", "isTerminalResult", "refreshModelCatalog", "selectRefinementModel", "refineSessionName", "shutdownChildSession", "runAgent"].map((name) => functionSource(name)),
		...["modelPolicyFrom", "makePlaceholder", "executeDispatch"].map((name) => functionSource(name, true)),
	].join("\n");
	const dispatch = new Function("dependencies", `${stripTypeScriptTypes(code)}
		return (params, signal) => executeDispatch(params, signal, undefined, undefined, undefined, undefined, undefined, ctx, agents);
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

test("compact status line includes session name, type, lifecycle, model, and thinking with optional second action line", () => {
	const code = stripTypeScriptTypes(`(() => {
		const sanitizeTitleText = (v) => String(v).replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, " ").replace(/\\s+/g, " ").trim();
		${functionSource("compactState")}
		const shortenPath = (value) => String(value);
		${functionSource("getToolCallSummary")}
		${functionSource("safeOneLine")}
		${functionSource("compactHeaderLine")}
		${functionSource("compactActionsLine")}
		${functionSource("formatAgentList")}
		return { compactHeaderLine, compactActionsLine, formatAgentList };
	})()`);
	const helpers = new Function(`return ${code};`)();
	const result = {
		sessionName: "Subagent Naming Fix",
		agentType: "coder",
		agent: "coder",
		state: "running",
		model: "github-copilot/gpt-5.3-codex",
		thinkingLevel: "medium",
		messages: [{
			role: "assistant",
			content: [
				{ type: "toolCall", name: "read", arguments: { path: "/workspace/.pi/agent/extensions/subagent.ts" } },
				{ type: "toolCall", name: "edit", arguments: { path: "/workspace/.pi/agent/extensions/status-panel.sh" } },
				{ type: "toolCall", name: "bash", arguments: { command: "node --experimental-strip-types --test .pi/agent/tests/*.test.ts" } },
			],
		}],
	};
	const header = helpers.compactHeaderLine(result);
	assert.equal(header, "Subagent Naming Fix · coder · running · github-copilot/gpt-5.3-codex · medium");
	const actions = helpers.compactActionsLine(result);
	assert.ok(actions?.includes("read /workspace/.pi/agent/extensions/subagent.ts"));
	assert.ok(actions?.includes("edit /workspace/.pi/agent/extensions/status-panel.sh"));
	assert.ok(actions?.includes("$ node --experimental-strip-types --test .pi/agent/tests/"));
	const list = helpers.formatAgentList([result]);
	assert.equal(list.length, 2);
	assert.equal(list[0], header);
	assert.ok(!list.join("\n").includes("agent-"));
	assert.ok(!list.join("\n").includes("starting"));
});

test("compact status omits action line when no real commands exist", () => {
	const code = stripTypeScriptTypes(`(() => {
		const sanitizeTitleText = (v) => String(v).replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, " ").replace(/\\s+/g, " ").trim();
		${functionSource("compactState")}
		const shortenPath = (value) => String(value);
		${functionSource("getToolCallSummary")}
		${functionSource("safeOneLine")}
		${functionSource("compactHeaderLine")}
		${functionSource("compactActionsLine")}
		${functionSource("formatAgentList")}
		return { formatAgentList };
	})()`);
	const { formatAgentList } = new Function(`return ${code};`)();
	const lines = formatAgentList([{
		sessionName: "Plan Task",
		agentType: "planner",
		agent: "planner",
		state: "queued",
		model: "pending",
		thinkingLevel: "pending",
		messages: [],
	}]);
	assert.deepEqual(lines, ["Plan Task · planner · queued · pending · pending"]);
});

function runAgentHarness(refinement: { value?: string; delayMs?: number } = {}) {
	const sessions: any[] = [];
	const ctx = {
		cwd: "/test",
		sessionManager: { getSessionId: () => "owner", getSessionFile: () => "/tmp/owner.jsonl" },
		model: { provider: "parent", id: "gpt" },
		thinkingLevel: "medium",
		scopedModels: [{ model: { provider: "parent", id: "gpt" } }],
		modelRegistry: {
			getAvailable: () => [{ provider: "agent", id: "mini" }],
			getAll: () => [{ provider: "agent", id: "mini" }],
			getError: () => undefined,
			getRegisteredProviderIds: () => [],
			getRegisteredNativeProvider: () => undefined,
			getRegisteredProviderConfig: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true }),
			refresh: async () => ({ aborted: false, errors: new Map() }),
			complete: async () => {
				if (refinement.delayMs) await new Promise((resolve) => setTimeout(resolve, refinement.delayMs));
				return { stopReason: "stop", content: refinement.value ? [{ type: "text", text: refinement.value }] : [] };
			},
		},
	};
	const dependencies = {
		...inspector,
		createChildSession: fakeChildSession,
		fs: { existsSync: () => false },
		MAX_CHILD_TRANSCRIPT_BYTES: 16 * 1024,
		TITLE_MAX_WORDS: 6,
		TITLE_MAX_CHARS: 48,
		TITLE_PROMPT_CHARS: 1000,
		TITLE_TIMEOUT_MS: 5000,
		sanitizeTitleText: (value: string) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim(),
		heuristicSessionName: (text: string) => text.split(/\s+/).slice(0, 2).join(" "),
		cleanGeneratedSessionName: (value: string) => value,
		mergeModelPolicy: () => ({ sources: {} }),
		refreshModelCatalog: async () => ({}),
		resolveModelSelection: async () => ({ model: { provider: "agent", id: "mini" }, thinkingLevel: "low", reason: "ok" }),
		getSupportedThinkingLevels: () => selection.THINKING_LEVELS,
		clampThinkingLevel: (_m: any, level: string) => level,
		getChildModelRuntime: async () => ({}),
		waitWithDeadline: async (operation: any, options: any) => operation(options?.signal),
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class { async reload() {} },
		getAgentDir: () => "/tmp",
		createAgentSession: async (options: any) => {
			const events: any[] = [];
			let listener: ((event: any) => void) | undefined;
			let aborted = false;
			const session = {
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				isIdle: true,
				isStreaming: false,
				bindExtensions: async () => {},
				setSessionName: (value: string) => events.push(value),
				subscribe: (cb: (event: any) => void) => { listener = cb; return () => { listener = undefined; events.push("__unsubscribed__"); }; },
				followUp: async () => {},
				steer: async () => {},
				abort: async () => { aborted = true; },
				dispose: () => { events.push("__disposed__"); },
				prompt: async () => {
					session.isStreaming = true;
					listener?.({ type: "agent_start" });
					await new Promise((resolve) => setTimeout(resolve, 40));
					listener?.({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "done" }],
							stopReason: aborted ? "aborted" : "stop",
							errorMessage: aborted ? "Subagent stopped" : undefined,
						},
					});
					session.isStreaming = false;
				},
			};
			sessions.push(events);
			return { session };
		},
		getGondolinToolProvider: () => ({ hostCwd: "/test", tools: [{ name: "read" }] }),
		resolveAuthoritativeCwd: () => "/test",
		childLimiter: { acquire: async () => () => {} },
		getFinalOutput: () => "done",
		truncateOutput: (value: string) => value,
		catalogRefreshers: new WeakMap(),
		ctx,
		agents: [{ name: "coder", description: "Coder", systemPrompt: "", source: "project", filePath: "", tools: ["read"] }],
	};
	const code = [
		...Object.keys(dependencies).map((name) => `const ${name} = dependencies.${name};`),
		...[
			"emptyUsage", "isFailedResult", "isTerminalResult", "truncateUtf8", "messageBytes", "compactTranscriptMessage", "appendBoundedMessage",
			"selectRefinementModel", "refineSessionName", "shutdownChildSession", "runAgent",
		].map((name) => functionSource(name)),
	].join("\n");
	const runAgent = new Function("dependencies", `${stripTypeScriptTypes(code)}\nreturn runAgent;`)(dependencies);
	return { runAgent, sessions, ctx, agents: dependencies.agents };
}

test("runAgent sets fallback title immediately and optional refinement updates only the child session name", async () => {
	const harness = runAgentHarness({ value: "Refined Child Name" });
	const updates: any[] = [];
	const result = await harness.runAgent("/test", harness.agents, "coder", "fix naming now", {
		controlIndex: 0,
		makeDetails: (results: any[]) => ({ mode: "single", results }),
		onUpdate: (value: any) => updates.push(value),
		parentCtx: harness.ctx,
	});
	assert.equal(result.state, "completed");
	assert.deepEqual(harness.sessions[0].slice(0, 2), ["fix naming", "Refined Child Name"]);
	assert.ok(harness.sessions[0].includes("__unsubscribed__"));
	assert.ok(harness.sessions[0].includes("__disposed__"));
	assert.ok(updates.some((update) => update.details?.results?.[0]?.sessionName === "Refined Child Name"));
});

test("runAgent parent abort keeps fallback name, cleans listeners, and ignores late title refinement", async () => {
	const harness = runAgentHarness({ value: "Late Name", delayMs: 100 });
	const controller = new AbortController();
	const execution = harness.runAgent("/test", harness.agents, "coder", "abort path", {
		controlIndex: 0,
		signal: controller.signal,
		makeDetails: (results: any[]) => ({ mode: "single", results }),
		parentCtx: harness.ctx,
	});
	await new Promise((resolve) => setTimeout(resolve, 5));
	controller.abort();
	const result = await execution;
	assert.equal(result.state, "aborted");
	assert.deepEqual(harness.sessions[0].filter((value: string) => !value.startsWith("__")), ["abort path"]);
	assert.ok(harness.sessions[0].includes("__unsubscribed__"));
	assert.ok(harness.sessions[0].includes("__disposed__"));
});
