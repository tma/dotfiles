/**
 * Protected Paths Extension
 *
 * Blocks write and edit operations to protected paths.
 * Useful for preventing accidental modifications to sensitive files.
 *
 * Paths are checked lexically and after resolving `~`, a leading `@`, the
 * session cwd, Gondolin's guest `/workspace`, and symlinks (including dangling
 * aliases to files that don't exist yet). Matching is case-insensitive.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";
const MAX_SYMLINK_HOPS = 40;
const protectedDirectories = new Set([".git", "node_modules", ".ssh"]);
const protectedFilenames = new Set([".npmrc", ".pypirc", ".netrc", "secrets.json"]);
const allowedEnvTemplates = new Set([".env.example", ".env.sample", ".env.template"]);
const protectedPathSuffixes = [[".pi", "agent", "auth.json"]];

function pathParts(filePath: string): string[] {
	return filePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

function isEnvFile(filename: string): boolean {
	return (filename === ".env" || filename.startsWith(".env.")) && !allowedEnvTemplates.has(filename);
}

function hasProtectedPart(filePath: string): boolean {
	const parts = pathParts(path.normalize(filePath)).map((part) => part.toLowerCase());
	const filename = parts[parts.length - 1] ?? "";

	return protectedFilenames.has(filename)
		|| isEnvFile(filename)
		|| parts.some((part) => protectedDirectories.has(part))
		|| protectedPathSuffixes.some((suffix) => suffix.every((part, index) => parts[parts.length - suffix.length + index] === part));
}

/** Absolute paths the input can name: as given and, for Gondolin tools, the host workspace. */
function candidatePaths(filePath: string, cwd: string): string[] {
	let expanded = filePath.trim().replace(/^@/, "");
	if (expanded === "~" || expanded.startsWith("~/")) expanded = os.homedir() + expanded.slice(1);

	const absolute = path.isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`;
	const candidates = [absolute];
	// Gondolin children and parents run with ctx.cwd set to the host workspace.
	if (absolute === GUEST_WORKSPACE || absolute.startsWith(`${GUEST_WORKSPACE}/`)) {
		candidates.push(`${cwd}${absolute.slice(GUEST_WORKSPACE.length)}`);
	}
	return candidates;
}

/**
 * Follows symlinks component by component without requiring the leaf to exist,
 * so a dangling alias to `.git/new-file` resolves to its target. Returns
 * undefined when resolution is ambiguous (loops, unreadable components).
 */
function resolveSymlinks(absolutePath: string): string | undefined {
	const root = path.parse(absolutePath).root;
	let resolved = root;
	let pending = pathParts(absolutePath.slice(root.length));
	let hops = 0;

	while (pending.length > 0) {
		const part = pending.shift()!;
		if (part === ".") continue;
		if (part === "..") {
			resolved = path.dirname(resolved);
			continue;
		}

		const next = path.join(resolved, part);
		let stats: fs.Stats;
		try {
			stats = fs.lstatSync(next);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return path.join(next, ...pending);
			return undefined;
		}

		if (!stats.isSymbolicLink()) {
			resolved = next;
			continue;
		}

		hops += 1;
		if (hops > MAX_SYMLINK_HOPS) return undefined;
		let target: string;
		try {
			target = fs.readlinkSync(next);
		} catch {
			return undefined;
		}
		if (path.isAbsolute(target)) resolved = path.parse(target).root;
		pending = [...pathParts(target), ...pending];
	}

	return resolved;
}

export function isProtectedPath(filePath: string, cwd: string): boolean {
	return candidatePaths(filePath, cwd).some((candidate) => {
		if (hasProtectedPart(candidate)) return true;
		const resolved = resolveSymlinks(candidate);
		return resolved === undefined || hasProtectedPart(resolved);
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}

		const filePath = event.input.path as string | undefined;
		if (!filePath) {
			return undefined;
		}

		if (isProtectedPath(filePath, ctx.cwd)) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked write to protected path: ${filePath}`, "warning");
			}
			return { block: true, reason: `Path "${filePath}" is protected` };
		}

		return undefined;
	});
}
