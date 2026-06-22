/**
 * Protected Paths Extension
 *
 * Blocks write and edit operations to protected paths.
 * Useful for preventing accidental modifications to sensitive files.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const protectedDirectories = new Set([".git", "node_modules", ".ssh"]);
const protectedFilenames = new Set([
	".env",
	".env.local",
	".npmrc",
	".pypirc",
	"secrets.json",
]);

function pathParts(filePath: string): string[] {
	return path
		.normalize(filePath)
		.replace(/\\/g, "/")
		.split("/")
		.filter(Boolean);
}

function isProtectedPath(filePath: string): boolean {
	const parts = pathParts(filePath);
	const filename = parts[parts.length - 1] ?? "";

	return protectedFilenames.has(filename)
		|| parts.some((part) => protectedDirectories.has(part));
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

		if (isProtectedPath(filePath)) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked write to protected path: ${filePath}`, "warning");
			}
			return { block: true, reason: `Path "${filePath}" is protected` };
		}

		return undefined;
	});
}
