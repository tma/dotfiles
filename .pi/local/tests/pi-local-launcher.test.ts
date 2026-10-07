import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Exercise the real pi-local function from .shellrc without sourcing the rest
// of the file (which runs gh, edits PATH, and so on).
const shellrc = readFileSync(new URL("../../../.shellrc", import.meta.url), "utf8");
const launcher = shellrc.match(/^pi-local\(\) \{[\s\S]*?^\}/m)?.[0];
const profileExtensions = readdirSync(new URL("../extensions", import.meta.url))
	.filter((name) => name.endsWith(".ts"))
	.sort();

const FAKE_PI = `#!/bin/sh
{
  for arg in "$@"; do printf 'arg=%s\\n' "$arg"; done
  printf 'env PAPERLESS_TOKEN=%s\\n' "\${PAPERLESS_TOKEN-unset}"
  printf 'env PI_LOCAL_ENV=%s\\n' "\${PI_LOCAL_ENV-unset}"
  printf 'env PI_LOCAL_LAUNCH_DIR=%s\\n' "\${PI_LOCAL_LAUNCH_DIR-unset}"
  printf 'env PI_CODING_AGENT_DIR=%s\\n' "\${PI_CODING_AGENT_DIR-unset}"
  printf 'env PI_OFFLINE=%s\\n' "\${PI_OFFLINE-unset}"
  printf 'env NO_PROXY=%s\\n' "\${NO_PROXY-unset}"
  printf 'env no_proxy=%s\\n' "\${no_proxy-unset}"
} > "$FAKE_PI_OUT"
`;

type Fixture = { root: string; home: string; launch: string; profile: string; out: string; marker: string };

function fixture(t: test.TestContext): Fixture {
	const root = mkdtempSync(path.join(tmpdir(), "pi-local-launcher-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "home");
	const launch = path.join(root, "launch");
	const profile = path.join(home, ".pi", "local");
	const bin = path.join(root, "bin");
	for (const dir of [launch, profile, bin]) mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(bin, "pi"), FAKE_PI);
	chmodSync(path.join(bin, "pi"), 0o755);
	const marker = path.join(root, "executed");
	writeFileSync(
		path.join(launch, ".env"),
		`PAPERLESS_TOKEN=example-token\nPAPERLESS_URL=$(touch ${marker})\n`,
	);
	return { root, home, launch, profile, out: path.join(root, "pi.out"), marker };
}

function run(shell: string, fx: Fixture, script: string) {
	assert.ok(launcher, ".shellrc must define pi-local()");
	const result = spawnSync(shell, ["-c", `${launcher}\ncd "$LAUNCH" || exit 99\n${script}`], {
		encoding: "utf8",
		env: {
			HOME: fx.home,
			PATH: `${path.join(fx.root, "bin")}:/usr/bin:/bin`,
			LAUNCH: fx.launch,
			FAKE_PI_OUT: fx.out,
		},
	});
	return result;
}

function childLines(fx: Fixture): string[] {
	return readFileSync(fx.out, "utf8").trim().split("\n");
}

const shells = ["bash", "zsh"].filter((shell) => spawnSync(shell, ["-c", "true"]).status === 0);

for (const shell of shells) {
	test(`${shell}: pi-local does not source .env or leak credentials into the parent shell`, (t) => {
		const fx = fixture(t);
		const result = run(shell, fx, `pi-local hello; printf 'parent=%s\\n' "\${PAPERLESS_TOKEN-unset}"`);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(fx.marker), false, ".env command substitution must not run");
		assert.match(result.stdout, /^parent=unset$/m);
		const lines = childLines(fx);
		assert.ok(lines.includes("env PAPERLESS_TOKEN=unset"), "Pi parses .env itself; the shell must not export it");
		assert.ok(lines.includes(`env PI_LOCAL_LAUNCH_DIR=${fx.launch}`));
		assert.ok(lines.includes(`env PI_CODING_AGENT_DIR=${fx.profile}`));
		assert.ok(lines.includes("env PI_OFFLINE=1"));
	});

	test(`${shell}: pi-local turns off proxy routing for Pi`, (t) => {
		const fx = fixture(t);
		const proxy = "http://proxy.example.com:3128";
		const result = run(
			shell,
			fx,
			`export HTTP_PROXY=${proxy} HTTPS_PROXY=${proxy} http_proxy=${proxy} https_proxy=${proxy} NO_PROXY=example.com
pi-local; printf 'parent=%s\\n' "$NO_PROXY"`,
		);
		assert.equal(result.status, 0, result.stderr);
		const lines = childLines(fx);
		assert.ok(lines.includes("env NO_PROXY=*"), lines.join("\n"));
		assert.ok(lines.includes("env no_proxy=*"), lines.join("\n"));
		assert.match(result.stdout, /^parent=example\.com$/m);
	});

	test(`${shell}: pi-local pins project trust and its own extensions before user args`, (t) => {
		const fx = fixture(t);
		const result = run(shell, fx, "pi-local --no-extensions hello");
		assert.equal(result.status, 0, result.stderr);
		const args = childLines(fx).filter((line) => line.startsWith("arg=")).map((line) => line.slice(4));
		const user = args.lastIndexOf("--no-extensions");
		assert.ok(args.indexOf("--no-approve") >= 0 && args.indexOf("--no-approve") < user);
		// Local extensions are explicit so a user -ne cannot drop the guard.
		const explicit = args.flatMap((arg, i) => (arg === "--extension" && i < user ? [args[i + 1]] : []));
		assert.deepEqual(
			explicit.map((file) => path.relative(path.join(fx.profile, "extensions"), file)).sort(),
			profileExtensions,
		);
		assert.ok(args.indexOf("--no-extensions") < user, "built-in and discovered extensions stay off");
		assert.equal(args.at(-1), "hello");
	});

	test(`${shell}: pi-local passes an unexported PI_LOCAL_ENV to Pi`, (t) => {
		const fx = fixture(t);
		const custom = path.join(fx.root, "custom.env");
		const result = run(shell, fx, `PI_LOCAL_ENV=${custom}\npi-local; printf 'parent=%s\\n' "$PI_LOCAL_ENV"`);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(childLines(fx).includes(`env PI_LOCAL_ENV=${custom}`));
		assert.match(result.stdout, new RegExp(`^parent=${custom}$`, "m"));
	});

	test(`${shell}: pi-local honors PI_LOCAL_DIR`, (t) => {
		const fx = fixture(t);
		const other = path.join(fx.root, "other-profile");
		mkdirSync(other);
		const result = run(shell, fx, `PI_LOCAL_DIR=${other} pi-local`);
		assert.equal(result.status, 0, result.stderr);
		const lines = childLines(fx);
		assert.ok(lines.includes(`env PI_CODING_AGENT_DIR=${other}`));
		assert.ok(lines.includes(`arg=${path.join(other, "extensions", "local-only.ts")}`));
	});

	for (const flag of ["--approve", "-a"]) {
		test(`${shell}: pi-local refuses ${flag}`, (t) => {
			const fx = fixture(t);
			const result = run(shell, fx, `pi-local ${flag} hello`);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /pi-local/);
			assert.equal(existsSync(fx.out), false, "Pi must not start");
		});
	}

	test(`${shell}: pi-local allows -a as message text after --`, (t) => {
		const fx = fixture(t);
		const result = run(shell, fx, "pi-local -- -a");
		assert.equal(result.status, 0, result.stderr);
		assert.equal(childLines(fx).filter((line) => line.startsWith("arg=")).at(-1), "arg=-a");
	});
}
