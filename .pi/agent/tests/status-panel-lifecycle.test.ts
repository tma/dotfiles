import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

type Handler = (event: unknown, ctx: unknown) => unknown;

const SURFACE = "surface:7";

// Loads status-panel.ts with child_process/fs mocked. The fake cmux refuses to
// close a surface that still runs a process unless --force is passed, and the
// fake tmux records kill-pane calls. Nothing touches a real mux or panel state.
async function loadExtension(backend: "cmux" | "tmux") {
	const calls: Array<{ command: string; args: string[] }> = [];
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	const exitListeners: Array<() => void> = [];
	const openSurfaces = new Set<string>();

	const original = {
		execFileSync: childProcess.execFileSync,
		execFile: childProcess.execFile,
		writeFileSync: fs.writeFileSync,
		unlinkSync: fs.unlinkSync,
		processOn: process.on,
		env: { ...process.env },
	};

	(childProcess as any).execFileSync = (command: string, args: string[]) => {
		calls.push({ command, args });
		if (command === "cmux" && args[0] === "new-split") {
			openSurfaces.add(SURFACE);
			return `OK ${SURFACE} workspace:1`;
		}
		if (command === "cmux" && args[0] === "close-surface") {
			const surface = args[args.indexOf("--surface") + 1];
			if (!args.includes("--force")) {
				throw new Error("confirmation_required: Surface has a running process; retry with force=true");
			}
			openSurfaces.delete(surface);
			return "OK";
		}
		if (command === "tmux" && args[0] === "split-window") return "%9";
		return "";
	};
	(childProcess as any).execFile = () => undefined;
	(fs as any).writeFileSync = () => undefined;
	(fs as any).unlinkSync = () => undefined;
	(process as any).on = (event: string, listener: () => void) => {
		if (event === "exit") exitListeners.push(listener);
		return process;
	};
	syncBuiltinESMExports();

	delete process.env.PI_DISABLE_MUX_UI;
	delete process.env.CMUX_WORKSPACE_ID;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	if (backend === "cmux") {
		process.env.CMUX_WORKSPACE_ID = "workspace:1";
	} else {
		process.env.TMUX = "/tmp/tmux-test/default,1,0";
		process.env.TMUX_PANE = "%1";
	}

	const mod = await import(`../extensions/status-panel.ts?lifecycle=${backend}-${Math.random()}`);
	mod.default({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerCommand: (name: string, spec: { handler: Handler }) => commands.set(name, spec),
		registerShortcut: () => undefined,
	});

	const ctx = {
		cwd: "/tmp/project",
		sessionManager: { getSessionFile: () => "/tmp/pi-test-sessions/session.jsonl" },
		ui: { notify: () => undefined },
	};

	return {
		calls,
		handlers,
		commands,
		exitListeners,
		openSurfaces,
		ctx,
		restore() {
			(childProcess as any).execFileSync = original.execFileSync;
			(childProcess as any).execFile = original.execFile;
			(fs as any).writeFileSync = original.writeFileSync;
			(fs as any).unlinkSync = original.unlinkSync;
			(process as any).on = original.processOn;
			syncBuiltinESMExports();
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, original.env);
		},
	};
}

function closeCalls(env: { calls: Array<{ command: string; args: string[] }> }, command: string, verb: string) {
	return env.calls.filter((call) => call.command === command && call.args[0] === verb);
}

test("cmux session_shutdown force-closes the owned status surface", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const env = await loadExtension("cmux");
	try {
		await env.handlers.get("session_start")!({}, env.ctx);
		assert.deepEqual([...env.openSurfaces], [SURFACE]);

		await env.handlers.get("session_shutdown")!({}, env.ctx);

		const closes = closeCalls(env, "cmux", "close-surface");
		assert.equal(closes.length, 1);
		assert.deepEqual(closes[0].args, ["close-surface", "--surface", SURFACE, "--force"]);
		assert.equal(env.openSurfaces.size, 0, "surface must be closed despite its running process");

		env.exitListeners.forEach((listener) => listener());
		assert.equal(closeCalls(env, "cmux", "close-surface").length, 1, "later cleanup must be idempotent");
	} finally {
		env.restore();
	}
});

test("cmux /status toggle force-closes the owned status surface", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const env = await loadExtension("cmux");
	try {
		await env.handlers.get("session_start")!({}, env.ctx);
		await env.commands.get("status")!.handler("", env.ctx);

		assert.equal(env.openSurfaces.size, 0);
		assert.ok(closeCalls(env, "cmux", "close-surface")[0].args.includes("--force"));
	} finally {
		env.restore();
	}
});

test("cmux process exit fallback force-closes the owned status surface", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const env = await loadExtension("cmux");
	try {
		await env.handlers.get("session_start")!({}, env.ctx);
		env.exitListeners.forEach((listener) => listener());

		assert.equal(env.openSurfaces.size, 0);
		assert.equal(closeCalls(env, "cmux", "close-surface").length, 1);
	} finally {
		env.restore();
	}
});

test("tmux shutdown still kills the pane without cmux flags", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const env = await loadExtension("tmux");
	try {
		await env.handlers.get("session_start")!({}, env.ctx);
		await env.handlers.get("session_shutdown")!({}, env.ctx);

		const kills = closeCalls(env, "tmux", "kill-pane");
		assert.equal(kills.length, 1);
		assert.deepEqual(kills[0].args, ["kill-pane", "-t", "%9"]);
		assert.equal(closeCalls(env, "cmux", "close-surface").length, 0);
	} finally {
		env.restore();
	}
});
