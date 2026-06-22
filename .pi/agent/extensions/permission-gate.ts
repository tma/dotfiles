/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Commands checked: rm -rf, sudo, chmod/chown 777, and SSH-style remote access
 * commands (ssh/scp/sftp/autossh/slogin and sshpass), including nested `shell -c`
 * invocations.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const dangerousPatterns = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];
const dangerousRemoteCommands = new Set(["ssh", "scp", "sftp", "autossh", "slogin", "sshpass"]);
const shellCommands = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh"]);
const commandSeparators = new Set([";", "&&", "||", "|", "&", "\n", "(", ")", "{", "}"]);
const syntaxPrefixes = new Set(["if", "then", "do", "else", "elif", "while", "until", "!"]);
const redirectionTokens = new Set([">", ">>", "<", "<<", "<<<", "<>", ">&", "<&", "|&"]);
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

function segmentInvokesDangerousRemoteCommand(segment: string[], depth = 0): boolean {
	if (depth > 4) return false;

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

		if (token === "env") {
			index += 1;
			while (index < segment.length && (segment[index].startsWith("-") || isEnvAssignment(segment[index]))) {
				index += 1;
			}
			continue;
		}

		if (["command", "builtin", "exec", "nohup", "time"].includes(token)) {
			index += 1;
			while (index < segment.length && segment[index].startsWith("-")) {
				index += 1;
			}
			continue;
		}

		const commandName = normalizeCommandName(token);
		if (dangerousRemoteCommands.has(commandName)) {
			return true;
		}

		if (shellCommands.has(commandName)) {
			const inlineScript = extractInlineShellScript(segment.slice(index + 1));
			if (inlineScript && hasDangerousRemoteCommand(inlineScript, depth + 1)) {
				return true;
			}
		}

		return false;
	}

	return false;
}

function hasDangerousRemoteCommand(command: string, depth = 0): boolean {
	if (depth > 4) return false;

	const tokens = tokenizeShell(command);
	let segment: string[] = [];

	for (const token of tokens) {
		if (commandSeparators.has(token)) {
			if (segmentInvokesDangerousRemoteCommand(segment, depth)) {
				return true;
			}
			segment = [];
			continue;
		}

		segment.push(token);
	}

	return segmentInvokesDangerousRemoteCommand(segment, depth);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const isDangerous = dangerousPatterns.some((pattern) => pattern.test(command)) || hasDangerousRemoteCommand(command);

		if (isDangerous) {
			if (!ctx.hasUI) {
				// In non-interactive mode, block by default
				return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
			}

			const preview = summarizeCommand(command);
			ctx.ui.notify("Dangerous bash command needs approval", "warning");
			pi.events.emit(attentionNotificationEvent, {
				title: "Pi waiting for confirmation",
				body: "Dangerous bash command needs Yes/No approval in Pi",
				subtitle: preview,
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
