/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Without a UI (print mode, subagent children), dangerous commands are blocked.
 *
 * Checked at command position: recursive rm, sudo, chmod/chown 777,
 * git reset --hard, forced git clean, and SSH-style remote access commands
 * (ssh/scp/sftp/autossh/slogin and sshpass). Common wrappers (env, command,
 * exec, nohup, time), nested `shell -c`, eval, and command substitutions are
 * followed. This is a best-effort speed bump, not a shell parser or sandbox.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_NESTING = 4;
const dangerousRemoteCommands = new Set(["ssh", "scp", "sftp", "autossh", "slogin", "sshpass"]);
const shellCommands = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh"]);
const commandSeparators = new Set([";", "&&", "||", "|", "|&", "&", "\n", "(", ")", "{", "}"]);
const syntaxPrefixes = new Set(["if", "then", "do", "else", "elif", "while", "until", "!"]);
const redirectionTokens = new Set([">", ">>", "<", "<<", "<<<", "<>", ">&", "<&"]);
const commandWrappers = new Set(["command", "builtin", "exec", "nohup", "time"]);
const envShortOptionsWithValue = new Set(["u", "C", "S", "P"]);
const envLongOptionsWithValue = new Set(["--unset", "--chdir", "--split-string"]);
const gitOptionsWithValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
const attentionNotificationEvent = "notify:attention";

function summarizeCommand(command: string, maxLength = 120): string {
	const singleLine = command.replace(/\s+/g, " ").trim();
	return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
}

function tokenizeShell(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	const pushCurrent = () => {
		if (current.length > 0) {
			tokens.push(current);
			current = "";
		}
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const nextThree = command.slice(i, i + 3);
		const nextTwo = command.slice(i, i + 2);

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (inSingleQuote) {
			if (char === "'") {
				inSingleQuote = false;
			} else {
				current += char;
			}
			continue;
		}

		if (inDoubleQuote) {
			if (char === '"') {
				inDoubleQuote = false;
			} else if (char === "\\") {
				escaped = true;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (char === "'") {
			inSingleQuote = true;
			continue;
		}

		if (char === '"') {
			inDoubleQuote = true;
			continue;
		}

		if (char === "\n") {
			pushCurrent();
			tokens.push("\n");
			continue;
		}

		if (/\s/.test(char)) {
			pushCurrent();
			continue;
		}

		if (nextThree === "<<<") {
			pushCurrent();
			tokens.push(nextThree);
			i += 2;
			continue;
		}

		if (["&&", "||", ">>", "<<", "<&", ">&", "|&", "<>"].includes(nextTwo)) {
			pushCurrent();
			tokens.push(nextTwo);
			i += 1;
			continue;
		}

		if (";|&()<>".includes(char) || char === "{" || char === "}") {
			pushCurrent();
			tokens.push(char);
			continue;
		}

		current += char;
	}

	pushCurrent();
	return tokens;
}

function isEnvAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function normalizeCommandName(token: string): string {
	return (token.split("/").pop() ?? token).toLowerCase();
}

function isShortOptionClusterWithC(token: string): boolean {
	return /^-[A-Za-z]*c[A-Za-z]*$/.test(token);
}

function skipRedirection(tokens: string[], index: number): number {
	const token = tokens[index];

	if (redirectionTokens.has(token)) {
		return Math.min(index + 2, tokens.length);
	}

	if (/^\d+$/.test(token) && index + 1 < tokens.length && redirectionTokens.has(tokens[index + 1])) {
		return Math.min(index + 3, tokens.length);
	}

	return index;
}

function extractInlineShellScript(args: string[]): string | null {
	for (let i = 0; i < args.length; i++) {
		const token = args[i];

		if (token === "--") {
			return null;
		}

		if (token === "-c" || isShortOptionClusterWithC(token)) {
			return args[i + 1] ?? null;
		}

		if (!token.startsWith("-")) {
			return null;
		}
	}

	return null;
}

/** Returns the argv that `env` runs, applying -S/--split-string and skipping option values. */
function envCommand(args: string[]): string[] {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--") return args.slice(i + 1);
		if (arg === "-" || isEnvAssignment(arg)) continue;

		if (arg.startsWith("--")) {
			const [name, ...inline] = arg.split("=");
			if (!envLongOptionsWithValue.has(name)) continue;
			const value = inline.length > 0 ? inline.join("=") : args[++i];
			if (name === "--split-string") return [...tokenizeShell(value ?? ""), ...args.slice(i + 1)];
			continue;
		}

		if (arg.startsWith("-")) {
			for (let c = 1; c < arg.length; c++) {
				if (!envShortOptionsWithValue.has(arg[c])) continue;
				const value = arg.slice(c + 1) || args[++i];
				if (arg[c] === "S") return [...tokenizeShell(value ?? ""), ...args.slice(i + 1)];
				break;
			}
			continue;
		}

		return args.slice(i);
	}

	return [];
}

/** Counts wrapper options (and their values) before the wrapped command. */
function wrapperOptionCount(wrapper: string, args: string[]): number {
	let count = 0;
	while (count < args.length && args[count].startsWith("-")) {
		count += wrapper === "exec" && args[count] === "-a" ? 2 : 1;
	}
	return count;
}

function isRecursiveRemove(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "--") return false;
		if (arg === "--recursive") return true;
		if (/^-[A-Za-z]+$/.test(arg) && /r/i.test(arg)) return true;
	}
	return false;
}

function isDestructiveGit(args: string[]): boolean {
	let index = 0;
	while (index < args.length && args[index].startsWith("-")) {
		index += gitOptionsWithValue.has(args[index]) ? 2 : 1;
	}

	const subcommand = args[index];
	const subcommandArgs = args.slice(index + 1);
	if (subcommand === "reset") return subcommandArgs.includes("--hard");
	if (subcommand === "clean") return subcommandArgs.some((arg) => arg === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg));
	return false;
}

function invocationIsDangerous(commandName: string, args: string[], depth: number): boolean {
	if (commandName === "sudo" || dangerousRemoteCommands.has(commandName)) return true;
	if (commandName === "rm") return isRecursiveRemove(args);
	if (commandName === "chmod" || commandName === "chown") return args.some((arg) => arg.includes("777"));
	if (commandName === "git") return isDestructiveGit(args);
	if (commandName === "eval") return commandIsDangerous(args.join(" "), depth + 1);

	if (shellCommands.has(commandName)) {
		const inlineScript = extractInlineShellScript(args);
		return inlineScript !== null && commandIsDangerous(inlineScript, depth + 1);
	}

	return false;
}

function segmentIsDangerous(segment: string[], depth: number): boolean {
	if (depth > MAX_NESTING) return true;

	let index = 0;

	while (index < segment.length) {
		const redirectionSkip = skipRedirection(segment, index);
		if (redirectionSkip !== index) {
			index = redirectionSkip;
			continue;
		}

		const token = segment[index];

		if (syntaxPrefixes.has(token) || isEnvAssignment(token)) {
			index += 1;
			continue;
		}

		const commandName = normalizeCommandName(token);
		const args = segment.slice(index + 1);

		if (commandName === "env") {
			return segmentIsDangerous(envCommand(args), depth + 1);
		}

		if (commandWrappers.has(commandName)) {
			index += 1 + wrapperOptionCount(commandName, args);
			continue;
		}

		return invocationIsDangerous(commandName, args, depth);
	}

	return false;
}

/** Index of the `)` closing a `$(` whose body starts at `start`. */
function substitutionEnd(command: string, start: number): number {
	let depth = 1;
	let inSingleQuote = false;
	let inDoubleQuote = false;

	for (let i = start; i < command.length; i++) {
		const char = command[i];
		if (inSingleQuote) {
			if (char === "'") inSingleQuote = false;
		} else if (char === "\\") {
			i += 1;
		} else if (inDoubleQuote) {
			if (char === '"') inDoubleQuote = false;
		} else if (char === "'") {
			inSingleQuote = true;
		} else if (char === '"') {
			inDoubleQuote = true;
		} else if (char === "(") {
			depth += 1;
		} else if (char === ")" && --depth === 0) {
			return i;
		}
	}

	return command.length;
}

/** Bodies of `$(...)` and backtick substitutions, which run even inside double quotes. */
function commandSubstitutions(command: string): string[] {
	const substitutions: string[] = [];
	let inSingleQuote = false;
	let inDoubleQuote = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (inSingleQuote) {
			if (char === "'") inSingleQuote = false;
			continue;
		}
		if (char === "\\") {
			i += 1;
		} else if (char === "'" && !inDoubleQuote) {
			inSingleQuote = true;
		} else if (char === '"') {
			inDoubleQuote = !inDoubleQuote;
		} else if (char === "$" && command[i + 1] === "(") {
			const end = substitutionEnd(command, i + 2);
			substitutions.push(command.slice(i + 2, end));
			i = end;
		} else if (char === "`") {
			const close = command.indexOf("`", i + 1);
			const end = close === -1 ? command.length : close;
			substitutions.push(command.slice(i + 1, end));
			i = end;
		}
	}

	return substitutions;
}

function commandIsDangerous(command: string, depth: number): boolean {
	if (depth > MAX_NESTING) return true;

	if (commandSubstitutions(command).some((substitution) => commandIsDangerous(substitution, depth + 1))) {
		return true;
	}

	let segment: string[] = [];
	for (const token of tokenizeShell(command)) {
		if (commandSeparators.has(token)) {
			if (segmentIsDangerous(segment, depth)) return true;
			segment = [];
			continue;
		}

		segment.push(token);
	}

	return segmentIsDangerous(segment, depth);
}

export function isDangerousCommand(command: string): boolean {
	return commandIsDangerous(command, 0);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		if (isDangerousCommand(command)) {
			if (!ctx.hasUI) {
				// In non-interactive mode, block by default
				return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
			}

			const preview = summarizeCommand(command);
			ctx.ui.notify("Dangerous bash command needs approval", "warning");
			pi.events.emit(attentionNotificationEvent, {
				title: "Pi",
				body: "Needs input · Approve command",
				logMessage: `Waiting for dangerous command approval: ${preview}`,
				level: "warning",
			});

			const allowed = await ctx.ui.confirm("⚠️ Dangerous command", `${command}\n\nAllow this command?`);

			if (!allowed) {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
