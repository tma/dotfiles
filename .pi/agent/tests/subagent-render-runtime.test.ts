import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fakeChildSession, inspector } from "./helpers/subagent-inspector.ts";

class Text {
	text: string;
	constructor(text: string, _x = 0, _y = 0) { this.text = text; }
	setText(text: string) { this.text = text; }
	render() { return [this.text]; }
	invalidate() {}
}

class Container {
	children: any[] = [];
	addChild(child: any) { this.children.push(child); }
	clear() { this.children = []; }
	render(width = 240) { return this.children.flatMap((child) => child.render?.(width) ?? []); }
	invalidate() {}
}

class Box extends Container {
	bgFn: (value: string) => string;
	constructor(_x = 0, _y = 0, bgFn: (value: string) => string = (value) => value) { super(); this.bgFn = bgFn; }
	setBgFn(fn: (value: string) => string) { this.bgFn = fn; }
	override render(width = 240) { return super.render(width).map((line: string) => this.bgFn(line)); }
}

class Spacer {
	lines: number;
	constructor(lines = 1) { this.lines = lines; }
	render() { return Array.from({ length: this.lines }, () => ""); }
	invalidate() {}
}

class Markdown extends Text {}

const source = await readFile(new URL("../extensions/subagent.ts", import.meta.url), "utf8");

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type SessionScript = {
	delayMs?: number;
	text?: string;
	stopReason?: string;
	errorMessage?: string;
	events?: any[];
	sendError?: string;
};

function createHarness(options: {
	scripts?: Record<string, SessionScript>;
	sendFailures?: number;
	sessionIds?: { current: string; file: string };
	persistenceError?: string;
	appendError?: string;
	sessionSaved?: boolean;
} = {}) {
	const handlers = new Map<string, Function[]>();
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const inputs: any[] = [];
	const notices: any[] = [];
	const storage: any[] = [];
	const messages: Array<{ payload: any; opts: any }> = [];
	let sendFailures = options.sendFailures ?? 0;
	const scripts = options.scripts ?? {};
	const owner = options.sessionIds ?? { current: "s1", file: "/tmp/s1/session.json" };

	const withoutImports = source
		.replace(/^import[\s\S]*?;\n/gm, "")
		.replace("constructor(private readonly limit: number) {}", "constructor(limit) { this.limit = limit; }");
	const js = stripTypeScriptTypes(withoutImports).replace(/export default function\s*\(\s*pi[^)]*\)/, "function __default(pi)");
	const deps = {
		...inspector,
		createChildSession: (...args: any[]) => {
			storage.push(args);
			if (options.persistenceError) throw new Error(options.persistenceError);
			return { ...fakeChildSession(), appendCustomEntry: () => { if (options.appendError) throw new Error(options.appendError); } };
		},
		fs: {
			existsSync: (p: string) => p.endsWith("/agents") || Boolean(options.sessionSaved && p.endsWith("native-child.jsonl")),
			readdirSync: () => [
				{ name: "coder.md", isFile: () => true, isSymbolicLink: () => false },
				{ name: "scout.md", isFile: () => true, isSymbolicLink: () => false },
			],
			statSync: (p: string) => {
				if (String(p).endsWith("/.pi/agents")) return { isDirectory: () => true };
				throw new Error("ENOENT");
			},
			readFileSync: (p: string) => String(p),
			realpathSync: { native: (p: string) => p },
			writeFileSync: () => {},
			renameSync: () => {},
			chmodSync: () => {},
			unlinkSync: () => {},
			mkdirSync: () => {},
		},
		os: { homedir: () => "/home/test", tmpdir: () => "/tmp" },
		path: {
			join: (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/"),
			dirname: (p: string) => p.split("/").slice(0, -1).join("/") || "/",
			resolve: (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/"),
			isAbsolute: (p: string) => p.startsWith("/"),
		},
		StringEnum: (...args: any[]) => args,
		clampThinkingLevel: (_model: any, level: string) => level,
		getSupportedThinkingLevels: () => ["off", "low", "medium", "high"],
		createAgentSession: async (sessionOptions: any) => {
			let listener: ((event: any) => void) | undefined;
			let aborted = false;
			let currentScript: SessionScript = {};
			const scriptFor = (task: string) => scripts[task] ?? {};
			const session = {
				model: sessionOptions.model,
				thinkingLevel: sessionOptions.thinkingLevel,
				isIdle: true,
				isStreaming: false,
				bindExtensions: async () => {},
				setSessionName: () => {},
				subscribe: (cb: (event: any) => void) => { listener = cb; return () => { listener = undefined; }; },
				steer: async (message: string) => { if (currentScript.sendError) throw new Error(currentScript.sendError); inputs.push({ message, delivery: "steer" }); },
				followUp: async (message: string) => { if (currentScript.sendError) throw new Error(currentScript.sendError); inputs.push({ message, delivery: "followUp" }); },
				abort: async () => { aborted = true; },
				dispose: () => {},
				prompt: async (promptText: string) => {
					session.isStreaming = true;
					listener?.({ type: "agent_start" });
					const task = promptText.replace(/^Task:\s*/, "");
					const script = scriptFor(task);
					currentScript = script;
					for (const event of script.events ?? []) listener?.(event);
					if (script.delayMs) await sleep(script.delayMs);
					if (!aborted) {
						listener?.({
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: script.text ?? `${task} done` }],
								stopReason: script.stopReason ?? "stop",
								errorMessage: script.errorMessage,
							},
						});
					} else {
						listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "aborted" }], stopReason: "aborted", errorMessage: "Subagent stopped" } });
					}
					session.isStreaming = false;
				},
			};
			return { session };
		},
		DefaultResourceLoader: class { async reload() {} },
		getAgentDir: () => "/tmp",
		getMarkdownTheme: () => ({}),
		ModelRuntime: { create: async () => ({ registerNativeProvider: () => {}, registerProvider: () => {} }) },
		parseFrontmatter: (content: string) => ({
			frontmatter: content.includes("scout.md")
				? { name: "scout", description: "Scout", tools: "read,bash" }
				: { name: "coder", description: "Coder", tools: "read,bash,edit,write" },
			body: "system",
		}),
		SettingsManager: { create: () => ({}) },
		truncateHead: (text: string) => ({ content: text, truncated: false }),
		DEFAULT_MAX_BYTES: 64 * 1024,
		DEFAULT_MAX_LINES: 2000,
		Container,
		Markdown,
		Spacer,
		Text,
		Box,
		Type: new Proxy({}, { get: () => (..._args: any[]) => ({}) }),
		getGondolinToolProvider: () => ({ hostCwd: "/workspace", tools: [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }] }),
		AUTO_POLICIES: ["cheap", "balanced", "strong"],
		CatalogRefreshCoordinator: class { async refresh() { return {}; } },
		mergeModelPolicy: () => ({ sources: {} }),
		resolveModelSelection: async () => ({ model: { provider: "p", id: "m" }, thinkingLevel: "low", reason: "ok" }),
		THINKING_LEVELS: ["off", "low", "medium", "high"],
		waitWithDeadline: async (fn: any) => fn(new AbortController().signal),
		cleanGeneratedSessionName: (value: string) => value,
		heuristicSessionName: () => "Task",
		sanitizeTitleText: (value: string) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim(),
		findPlanFile: () => undefined,
	};
	const prelude = Object.keys(deps).map((name) => `const ${name} = deps.${name};`).join("\n");
	const extension = new Function("deps", `${prelude}\n${js}\nreturn __default;`)(deps);

	const pi = {
		registerTool: (tool: any) => tools.push(tool),
		on: (event: string, handler: Function) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut),
		sendUserMessage: () => {},
		sendMessage: (payload: any, opts: any) => {
			if (sendFailures > 0) {
				sendFailures--;
				throw new Error("send failed");
			}
			messages.push({ payload, opts });
		},
	};
	extension(pi as any);

	const ctx = {
		cwd: "/workspace",
		mode: "tui",
		hasUI: false,
		ui: { setWidget: () => {}, setStatus: () => {}, notify: (message: string, level: string) => notices.push({ message, level }), confirm: async () => false, input: async () => "input" },
		model: { provider: "p", id: "m" },
		thinkingLevel: "low",
		scopedModels: [{ model: { provider: "p", id: "m" } }],
		modelRegistry: {
			getAvailable: () => [{ provider: "p", id: "m" }],
			getAll: () => [{ provider: "p", id: "m" }],
			getError: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true }),
			refresh: async () => ({ aborted: false, errors: new Map() }),
			getRegisteredProviderIds: () => [],
			getRegisteredNativeProvider: () => undefined,
			getRegisteredProviderConfig: () => undefined,
		},
		sessionManager: {
			getSessionId: () => owner.current,
			getSessionFile: () => owner.file,
		},
	};

	let started = false;
	let stopped = false;

	async function emit(event: string, eventPayload = {}) {
		if (event === "session_start") started = true;
		if (event === "session_shutdown") stopped = true;
		for (const handler of handlers.get(event) ?? []) await handler(eventPayload, ctx as any);
	}

	async function shutdown() {
		if (!started || stopped) return;
		await emit("session_shutdown");
	}

	return { tools, emit, shutdown, ctx, messages, owner, handlers, commands, shortcuts, inputs, notices, storage };
}

const theme = {
	fg: (_key: string, text: string) => text,
	bg: (key: string, text: string) => `<${key}>${text}</${key}>`,
	bold: (text: string) => text,
};

function withHarness(t: any, options?: Parameters<typeof createHarness>[0]) {
	const runtime = createHarness(options);
	t.after(async () => {
		await runtime.shutdown();
	});
	return runtime;
}

test("subagent tool keeps self shell renderer and hides job id from result rendering", (t) => {
	const runtime = withHarness(t);
	const subagent = runtime.tools.find((tool) => tool.name === "subagent");
	assert.ok(subagent);
	assert.equal(subagent.renderShell, "self");

	const details = {
		mode: "single",
		results: [{
			agent: "coder",
			agentType: "coder",
			sessionName: "Fix Dispatch",
			task: "x",
			state: "running",
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: "provider/model",
			thinkingLevel: "low",
		}],
		jobId: "agent-abc",
	};
	const normal = subagent.renderResult({ content: [{ type: "text", text: "job agent-abc" }], details }, { expanded: false }, theme, { isError: false }).render(200).join("\n");
	assert.match(normal, /<toolPendingBg>/);
	assert.doesNotMatch(normal, /agent-abc/);
	assert.match(normal, /Fix Dispatch · coder · running · provider\/model · low/);
});

test("status summary render collapses long multi-child output and expands to full authoritative status text", (t) => {
	const runtime = withHarness(t);
	const subagent = runtime.tools.find((tool) => tool.name === "subagent");
	assert.ok(subagent);
	const makeResult = (index: number, state: "completed" | "running" | "failed") => ({
		agent: `agent-${index}`,
		agentType: index % 2 ? "coder" : "scout",
		sessionName: `Child ${index}`,
		task: `task ${index}`,
		state,
		exitCode: state === "failed" ? 1 : 0,
		messages: [],
		stderr: state === "failed" ? "stderr boom" : "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: "provider/model",
		thinkingLevel: "low",
		errorMessage: state === "failed" ? "child failed" : undefined,
	});
	const details = {
		mode: "parallel",
		results: [
			makeResult(1, "completed"),
			makeResult(2, "running"),
			makeResult(3, "completed"),
			makeResult(4, "failed"),
			makeResult(5, "completed"),
			makeResult(6, "completed"),
		],
		jobId: "agent-long",
		state: "failed",
	};
	const longTail = `${"status tail ".repeat(30)}TAIL-MULTI`;
	const statusText = [
		"job agent-long",
		"Child 1 · done",
		"Child 2 · running",
		"Child 3 · done",
		"Child 4 · failed",
		"Child 5 · done",
		"Child 6 · done",
		"input delivery: child 1 rejected steer input",
		"error: widget crash",
		"error: second failure with context",
		`error: deep diagnostic ${longTail}`,
	].join("\n");
	const collapsed = subagent.renderResult(
		{ content: [{ type: "text", text: statusText }], details },
		{ expanded: false },
		theme,
		{ isError: false, args: { action: "status", id: "agent-long" } },
	).render(240).join("\n");
	assert.match(collapsed, /status 6 children · 1 running · 4 done · 1 failed/);
	assert.match(collapsed, /Child 1/);
	assert.match(collapsed, /Child 3/);
	assert.doesNotMatch(collapsed, /Child 4/);
	assert.match(collapsed, /… 3 more children/);
	assert.match(collapsed, /input delivery: child 1 rejected steer input/);
	assert.match(collapsed, /Expand for full status output/);
	assert.doesNotMatch(collapsed, /TAIL-MULTI/);

	const expanded = subagent.renderResult(
		{ content: [{ type: "text", text: statusText }], details },
		{ expanded: true },
		theme,
		{ isError: false, args: { action: "status", id: "agent-long" } },
	).render(240).join("\n");
	assert.match(expanded, /Child 4 · failed/);
	assert.match(expanded, /error: widget crash/);
	assert.match(expanded, /error: second failure with context/);
	assert.match(expanded, /TAIL-MULTI/);
});

test("expanded status for single-child jobs keeps full job-level failures", (t) => {
	const runtime = withHarness(t);
	const subagent = runtime.tools.find((tool) => tool.name === "subagent");
	assert.ok(subagent);
	const details = {
		mode: "single",
		results: [{
			agent: "coder",
			agentType: "coder",
			sessionName: "Single Child",
			task: "x",
			state: "failed",
			exitCode: 1,
			messages: [],
			stderr: "stderr",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: "provider/model",
			thinkingLevel: "low",
			errorMessage: "child failed",
		}],
		jobId: "agent-single",
		state: "failed",
	};
	const failureTail = `${"full single diagnostics ".repeat(25)}TAIL-SINGLE`;
	const statusText = [
		"job agent-single",
		"Single Child · coder · failed · provider/model · low",
		"input delivery: completion delivery failed for child 0",
		`error: coordinator callback failed ${failureTail}`,
	].join("\n");
	const collapsed = subagent.renderResult(
		{ content: [{ type: "text", text: statusText }], details },
		{ expanded: false },
		theme,
		{ isError: true, args: { action: "status", id: "agent-single" } },
	).render(240).join("\n");
	assert.match(collapsed, /status 1 child · 1 failed/);
	assert.match(collapsed, /input delivery: completion delivery failed for child 0/);
	assert.doesNotMatch(collapsed, /TAIL-SINGLE/);

	const expanded = subagent.renderResult(
		{ content: [{ type: "text", text: statusText }], details },
		{ expanded: true },
		theme,
		{ isError: true, args: { action: "status", id: "agent-single" } },
	).render(240).join("\n");
	assert.match(expanded, /input delivery: completion delivery failed for child 0/);
	assert.match(expanded, /error: coordinator callback failed/);
	assert.match(expanded, /TAIL-SINGLE/);
});

test("status detail render keeps transcript behind expanded toggle", (t) => {
	const runtime = withHarness(t);
	const subagent = runtime.tools.find((tool) => tool.name === "subagent");
	assert.ok(subagent);
	const longDetail = `job agent-live · child 0\nRECENT: ${"streaming output ".repeat(50)}TAIL-MARKER\n\n[detail offset 0; next offset 600; native session contains full transcript]`;
	const collapsed = subagent.renderResult(
		{ content: [{ type: "text", text: longDetail }], details: undefined },
		{ expanded: false },
		theme,
		{ isError: false, args: { action: "status", view: "detail", id: "agent-live", index: 0 } },
	).render(240).join("\n");
	assert.match(collapsed, /status detail/);
	assert.match(collapsed, /Expand to view the detail page/);
	assert.doesNotMatch(collapsed, /TAIL-MARKER/);

	const expanded = subagent.renderResult(
		{ content: [{ type: "text", text: longDetail }], details: undefined },
		{ expanded: true },
		theme,
		{ isError: false, args: { action: "status", view: "detail", id: "agent-live", index: 0 } },
	).render(240).join("\n");
	assert.match(expanded, /TAIL-MARKER/);
	assert.match(expanded, /detail offset 0; next offset 600/);
});

test("status summary without structured details stays compact when collapsed", (t) => {
	const runtime = withHarness(t);
	const subagent = runtime.tools.find((tool) => tool.name === "subagent");
	assert.ok(subagent);
	const raw = `No unique subagent job matches \"agent-missing\".\n${"x".repeat(600)}TAIL-END`;
	const collapsed = subagent.renderResult(
		{ content: [{ type: "text", text: raw }], details: undefined },
		{ expanded: false },
		theme,
		{ isError: true, args: { action: "status", id: "agent-missing" } },
	).render(240).join("\n");
	assert.match(collapsed, /status No unique subagent job matches/);
	assert.match(collapsed, /Expand for full status output/);
	assert.doesNotMatch(collapsed, /TAIL-END/);

	const expanded = subagent.renderResult(
		{ content: [{ type: "text", text: raw }], details: undefined },
		{ expanded: true },
		theme,
		{ isError: true, args: { action: "status", id: "agent-missing" } },
	).render(240).join("\n");
	assert.match(expanded, /TAIL-END/);
});

test("parallel completion delivery sends first completed child before later children and uses follow-up trigger", async (t) => {
	const runtime = withHarness(t, {
		scripts: {
			fast: { delayMs: 20, text: "fast ✅" },
			slow: { delayMs: 450, text: "slow ✅" },
		},
	});
	const subagent = runtime.tools.find((tool) => tool.name === "subagent");
	await runtime.emit("session_start");
	const launched = await subagent.execute("id", {
		tasks: [{ agent: "coder", task: "fast" }, { agent: "scout", task: "slow" }],
	}, undefined, undefined, runtime.ctx);
	assert.equal(launched.details.mode, "parallel");
	assert.equal(launched.details.state, "running");

	await sleep(330);
	assert.equal(runtime.messages.length, 1);
	assert.equal(runtime.messages[0].payload.customType, "subagent-completion");
	assert.match(runtime.messages[0].payload.content[0].text, /child 1\/2/);
	assert.doesNotMatch(runtime.messages[0].payload.content[0].text, /child 2\/2/);
	assert.deepEqual(runtime.messages[0].opts, { triggerTurn: true, deliverAs: "followUp" });

	await sleep(450);
	assert.equal(runtime.messages.length, 2);
	assert.match(runtime.messages[1].payload.content[0].text, /child 2\/2/);
	const all = runtime.messages.map((message) => message.payload.content[0].text).join("\n\n");
	assert.equal((all.match(/child 1\/2/g) ?? []).length, 1);
	assert.equal((all.match(/child 2\/2/g) ?? []).length, 1);
});

test("completion retries after send failure and marks delivered only after accepted send", async (t) => {
	const runtime = withHarness(t, {
		sendFailures: 1,
		scripts: { once: { delayMs: 10, text: "done" } },
	});
	const subagent = runtime.tools.find((tool) => tool.name === "subagent");
	await runtime.emit("session_start");
	const launched = await subagent.execute("id", { agent: "coder", task: "once" }, undefined, undefined, runtime.ctx);
	await sleep(900);
	assert.equal(runtime.messages.length, 1);
	assert.match(runtime.messages[0].payload.content[0].text, /child 1\/1/);

	const status = await subagent.execute("id", { action: "status", id: launched.details.jobId }, undefined, undefined, runtime.ctx);
	const statusText = status.content[0].text;
	assert.match(statusText, /input delivery: completion delivery failed for child 0/);
});

test("before-agent reminder says completions are already delivered and status is optional", async (t) => {
	const runtime = withHarness(t);
	const subagent = runtime.tools.find((tool) => tool.name === "subagent");
	await runtime.emit("session_start");
	await subagent.execute("id", { agent: "coder", task: "status-reminder" }, undefined, undefined, runtime.ctx);
	const before = runtime.handlers.get("before_agent_start")?.[0];
	assert.ok(before);
	const response = await before({}, runtime.ctx);
	assert.match(response.message.content, /Self-contained child completions are delivered automatically/);
	assert.match(response.message.content, /subagent action=status only when the user asks/);
});

test("completion error output excludes normal stop but keeps skipped chain failures", async (t) => {
	const runtime = withHarness(t, { scripts: { fail: { delayMs: 10, stopReason: "error", errorMessage: "step failed", text: "partial" } } });
	const subagent = runtime.tools.find((tool) => tool.name === "subagent");
	await runtime.emit("session_start");
	await subagent.execute("id", {
		chain: [
			{ agent: "coder", task: "fail" },
			{ agent: "scout", task: "{previous}" },
		],
	}, undefined, undefined, runtime.ctx);
	await sleep(700);

	const completionText = runtime.messages.map((message) => message.payload.content[0].text).join("\n\n---\n\n");
	assert.match(completionText, /step 1/);
	assert.match(completionText, /error:\nerror; step failed/);
	assert.match(completionText, /step 2/);
	assert.match(completionText, /error:\nskipped; Chain stopped before this step/);

	const clean = withHarness(t, { scripts: { ok: { delayMs: 10, stopReason: "stop", text: "normal" } } });
	const stopFlow = withHarness(t, { scripts: { hold: { delayMs: 350, text: "waiting" } } });
	const stopTool = stopFlow.tools.find((tool) => tool.name === "subagent");
	await stopFlow.emit("session_start");
	const launched = await stopTool.execute("id", { chain: [{ agent: "coder", task: "hold" }, { agent: "scout", task: "{previous}" }] }, undefined, undefined, stopFlow.ctx);
	await stopTool.execute("id", { action: "stop", id: launched.details.jobId }, undefined, undefined, stopFlow.ctx);
	await sleep(900);
	const stoppedCompletions = stopFlow.messages.map((message) => message.payload.content[0].text).join("\n\n");
	assert.match(stoppedCompletions, /step 2/);
	assert.match(stoppedCompletions, /error:\nskipped; Chain stopped before this step/);
	const cleanTool = clean.tools.find((tool) => tool.name === "subagent");
	await clean.emit("session_start");
	await cleanTool.execute("id", { agent: "coder", task: "ok" }, undefined, undefined, clean.ctx);
	await sleep(500);
	const cleanText = clean.messages[0].payload.content[0].text;
	assert.doesNotMatch(cleanText, /error:\nstop/);
});

test("large multibyte completion batches preserve child metadata and stay within 64KiB with explicit truncation", async (t) => {
	const big = "火".repeat(20_000);
	const runtime = withHarness(t, {
		scripts: {
			b1: { delayMs: 20, text: big },
			b2: { delayMs: 20, text: big },
			b3: { delayMs: 20, text: big },
		},
	});
	const subagent = runtime.tools.find((tool) => tool.name === "subagent");
	await runtime.emit("session_start");
	await subagent.execute("id", {
		tasks: [{ agent: "coder", task: "b1" }, { agent: "scout", task: "b2" }, { agent: "coder", task: "b3" }],
	}, undefined, undefined, runtime.ctx);
	await sleep(1000);

	assert.ok(runtime.messages.length >= 1);
	const combined = runtime.messages.map((message) => message.payload.content[0].text).join("\n\n");
	assert.match(combined, /child 1\/3/);
	assert.match(combined, /child 2\/3/);
	assert.match(combined, /child 3\/3/);
	for (const message of runtime.messages) {
		if (message.payload.customType !== "subagent-completion") continue;
		assert.ok(Buffer.byteLength(message.payload.content[0].text, "utf8") <= 64 * 1024);
	}
	assert.match(combined, /\[truncated\]|Child completion truncated\. Use subagent action=status for full transcript\./);
});

test("dispatch callback rejection marks queued children terminal and reports the failure", async (t) => {
	const runtime = withHarness(t, { scripts: { crash: { delayMs: 60, text: "done" } } });
	const subagent = runtime.tools.find((tool) => tool.name === "subagent");
	let remainingWidgetThrows = 0;
	runtime.ctx.hasUI = true;
	runtime.ctx.ui.setWidget = () => {
		if (remainingWidgetThrows <= 0) return;
		remainingWidgetThrows--;
		throw new Error("widget crash");
	};
	runtime.ctx.ui.setStatus = () => {};
	await runtime.emit("session_start");
	const launched = await subagent.execute("id", {
		chain: [{ agent: "coder", task: "crash" }, { agent: "scout", task: "{previous}" }],
	}, undefined, undefined, runtime.ctx);
	remainingWidgetThrows = 1;
	await sleep(900);
	const status = await subagent.execute("id", { action: "status", id: launched.details.jobId }, undefined, undefined, runtime.ctx);
	assert.match(status.content[0].text, /error: widget crash/);
	const completionText = runtime.messages.map((message) => message.payload.content[0].text).join("\n\n");
	assert.match(completionText, /step 2/);
	assert.match(completionText, /error:\nskipped; Chain stopped before this step/);
});

test("owner switch and shutdown prevent stale completion delivery", async (t) => {
	const runtime = withHarness(t, { scripts: { late: { delayMs: 300, text: "late" } } });
	const subagent = runtime.tools.find((tool) => tool.name === "subagent");
	await runtime.emit("session_start");
	await subagent.execute("id", { agent: "coder", task: "late" }, undefined, undefined, runtime.ctx);
	await sleep(50);
	runtime.owner.current = "s2";
	runtime.owner.file = "/tmp/s2/session.json";
	await runtime.emit("session_start");
	await sleep(700);
	assert.equal(runtime.messages.length, 0);

	runtime.owner.current = "s3";
	runtime.owner.file = "/tmp/s3/session.json";
	await runtime.emit("session_start");
	await subagent.execute("id", { agent: "coder", task: "late" }, undefined, undefined, runtime.ctx);
	await runtime.emit("session_shutdown");
	await sleep(500);
	assert.equal(runtime.messages.length, 0);
});

test("live detail uses real event wiring, requires child index, and rejects previous owners", async (t) => {
	const runtime = withHarness(t, { scripts: { live: { delayMs: 150, events: [
		{ type: "message_update", message: { content: [{ type: "text", text: "checking now" }, { type: "thinking", thinking: "hidden" }] }, assistantMessageEvent: { type: "text_delta", delta: "checking now" } },
		{ type: "tool_execution_start", toolCallId: "read1", toolName: "read", args: { path: "/workspace/exact.ts", offset: 21 } },
		{ type: "tool_execution_update", toolCallId: "read1", partialResult: { content: [{ type: "text", text: "partial result\x1b]52;bad\x07" }] } },
	] } } });
	await runtime.emit("session_start");
	const tool = runtime.tools[0];
	const launch = await tool.execute("id", { agent: "coder", task: "live" }, undefined, undefined, runtime.ctx);
	await sleep(30);
	const request = (params: any) => tool.execute("id", { action: "status", id: launch.details.jobId, ...params }, undefined, undefined, runtime.ctx);
	const summary = await request({});
	assert.doesNotMatch(summary.content[0].text, /partial result|checking now/);
	const detail = await request({ view: "detail", index: 0 });
	assert.match(detail.content[0].text, /checking now/);
	assert.match(detail.content[0].text, /\/workspace\/exact.ts/);
	assert.match(detail.content[0].text, /partial result/);
	assert.doesNotMatch(detail.content[0].text, /hidden|\x1b|\x07/);
	assert.match(detail.content[0].text, /pending; no saved transcript yet/);
	assert.equal(detail.details, undefined);
	for (const index of [undefined, -1, 1, 0.5]) await assert.rejects(request({ view: "detail", index }), /child index/);
	assert.deepEqual(runtime.storage[0], ["/workspace", "s1", "/tmp/s1/session.json"]);
	runtime.owner.current = "s2";
	runtime.owner.file = "/tmp/s2/session.json";
	await runtime.emit("session_start");
	await assert.rejects(request({ view: "detail", index: 0 }), /current-session job/);
	await assert.rejects(tool.execute("id", { action: "send", id: launch.details.jobId, message: "wrong owner", index: 0 }, undefined, undefined, runtime.ctx), /running job/);
});

test("direct controls report queueing, real acceptance, dispatch errors and stop confirmation", async (t) => {
	const runtime = withHarness(t, { scripts: { hold: { delayMs: 300 }, reject: { delayMs: 300, sendError: "queue rejected" } } });
	await runtime.emit("session_start");
	const tool = runtime.tools[0];
	const launch = await tool.execute("id", { tasks: [{ agent: "coder", task: "hold" }, { agent: "scout", task: "reject" }] }, undefined, undefined, runtime.ctx);
	const id = launch.details.jobId;
	const queued = await tool.execute("id", { action: "send", id, index: 0, message: "queued" }, undefined, undefined, runtime.ctx);
	assert.match(queued.content[0].text, /not yet delivered/);
	await sleep(30);
	assert.ok(runtime.inputs.some((input) => input.message === "queued"));
	const command = runtime.commands.get("agents");
	assert.ok(runtime.shortcuts.has("ctrl+shift+a"));
	await command.handler(`follow-up ${id} 0 check\n  exact spacing`, runtime.ctx);
	assert.deepEqual(runtime.inputs.at(-1), { message: "check\n  exact spacing", delivery: "followUp" });
	assert.match(runtime.notices.at(-1).message, /Accepted followUp/);
	await command.handler(`steer ${id} 1 reject this`, runtime.ctx);
	assert.equal(runtime.notices.at(-1).level, "error");
	assert.match(runtime.notices.at(-1).message, /No active child/);
	for (const index of [-1, 0.5, 2]) await assert.rejects(tool.execute("id", { action: "send", id, index, message: "invalid" }, undefined, undefined, runtime.ctx), /outside/);
	await assert.rejects(tool.execute("id", { action: "send", id, message: "partial" }, undefined, undefined, runtime.ctx), /other children rejected/);
	const status = await tool.execute("id", { action: "status", id }, undefined, undefined, runtime.ctx);
	assert.match(status.content[0].text, /queue rejected/);
	await command.handler(`stop ${id}`, runtime.ctx);
	assert.equal((await tool.execute("id", { action: "status", id }, undefined, undefined, runtime.ctx)).details.state, "running");
	runtime.ctx.ui.confirm = async () => true;
	await command.handler(`stop ${id}`, runtime.ctx);
	assert.match(runtime.notices.at(-1).message, /Stop requested/);
});

test("session replacement during confirmation cancels old-owner controls", async (t) => {
	const runtime = withHarness(t, { scripts: { hold: { delayMs: 200 } } });
	await runtime.emit("session_start");
	const launch = await runtime.tools[0].execute("id", { agent: "coder", task: "hold" }, undefined, undefined, runtime.ctx);
	let confirm!: (value: boolean) => void;
	runtime.ctx.ui.confirm = () => new Promise((resolve) => { confirm = resolve; });
	const pending = runtime.commands.get("agents").handler(`stop ${launch.details.jobId}`, runtime.ctx);
	await sleep(10);
	runtime.owner.current = "s2";
	runtime.owner.file = "/tmp/s2/session.json";
	await runtime.emit("session_start");
	confirm(true);
	await pending;
	assert.deepEqual(runtime.notices, []);
});

for (const failure of ["persistenceError", "appendError"] as const) test(`native ${failure} fails clearly without pretending a transcript was saved`, async (t) => {
	const runtime = withHarness(t, { [failure]: "disk unavailable" });
	await runtime.emit("session_start");
	const launch = await runtime.tools[0].execute("id", { agent: "coder", task: "save" }, undefined, undefined, runtime.ctx);
	await sleep(30);
	const status = await runtime.tools[0].execute("id", { action: "status", id: launch.details.jobId, view: "detail", index: 0 }, undefined, undefined, runtime.ctx);
	assert.match(status.content[0].text, /PERSISTENCE ERROR:.*disk unavailable/);
	assert.match(status.content[0].text, /state: failed/);
	assert.doesNotMatch(status.content[0].text, /file exists/);
});

for (const state of ["aborted", "failed"]) test(`runAgent cleanup labels an unfinished tool interrupted when ${state}`, async (t) => {
	const runtime = withHarness(t, { scripts: { hold: { delayMs: 60, stopReason: state === "failed" ? "error" : "stop", events: [
		{ type: "tool_execution_start", toolCallId: "unfinished", toolName: "bash", args: { command: "test" } },
	] } } });
	await runtime.emit("session_start");
	const tool = runtime.tools[0];
	const launch = await tool.execute("id", { agent: "coder", task: "hold" }, undefined, undefined, runtime.ctx);
	await sleep(20);
	if (state === "aborted") await tool.execute("id", { action: "stop", id: launch.details.jobId }, undefined, undefined, runtime.ctx);
	await sleep(80);
	const detail = await tool.execute("id", { action: "status", id: launch.details.jobId, view: "detail", index: 0 }, undefined, undefined, runtime.ctx);
	assert.match(detail.content[0].text, new RegExp(`state: ${state}`));
	assert.match(detail.content[0].text, /bash · \d+s · interrupted/);
	assert.doesNotMatch(detail.content[0].text, /bash · \d+s · done/);
});
