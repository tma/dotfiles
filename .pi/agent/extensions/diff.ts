/**
 * Diff Extension
 *
 * /diff command shows modified/deleted/new files from git status and opens
 * the selected file in Zed's diff view.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

interface FileInfo {
	status: string;
	statusLabel: string;
	file: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("diff", {
		description: "Show git changes and open diff in Zed",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("No UI available", "error");
				return;
			}

			// Get changed files from git status
			const result = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });

			if (result.code !== 0) {
				ctx.ui.notify(`git status failed: ${result.stderr}`, "error");
				return;
			}

			if (!result.stdout || !result.stdout.trim()) {
				ctx.ui.notify("No changes in working tree", "info");
				return;
			}

			// Parse git status output
			// Format: XY filename (where XY is two-letter status, then space, then filename)
			const lines = result.stdout.split("\n");
			const files: FileInfo[] = [];

			for (const line of lines) {
				if (line.length < 4) continue; // Need at least "XY f"

				const status = line.slice(0, 2);
				const file = line.slice(2).trimStart();

				// Translate status codes to short labels
				let statusLabel: string;
				if (status.includes("M")) statusLabel = "M";
				else if (status.includes("A")) statusLabel = "A";
				else if (status.includes("D")) statusLabel = "D";
				else if (status.includes("?")) statusLabel = "?";
				else if (status.includes("R")) statusLabel = "R";
				else if (status.includes("C")) statusLabel = "C";
				else statusLabel = status.trim() || "~";

				files.push({ status: statusLabel, statusLabel, file });
			}

			if (files.length === 0) {
				ctx.ui.notify("No changes found", "info");
				return;
			}

			const openSelected = async (fileInfo: FileInfo): Promise<void> => {
				try {
					if (fileInfo.status === "?") {
						// Untracked: just open the file
						const r = await pi.exec("zed", [fileInfo.file], { cwd: ctx.cwd });
						if (r.code !== 0) ctx.ui.notify(`Failed to open ${fileInfo.file}`, "error");
						return;
					}

					// Create temp file with HEAD version for Zed --diff
					const tmpResult = await pi.exec("mktemp", ["/tmp/zed-diff-XXXXXX"], { cwd: ctx.cwd });
					const tmpFile = tmpResult.stdout.trim();
					await pi.exec("bash", ["-c", `git show HEAD:${fileInfo.file} > ${tmpFile} 2>/dev/null || true`], { cwd: ctx.cwd });

					const r = await pi.exec("zed", ["--diff", tmpFile, fileInfo.file], { cwd: ctx.cwd });
					if (r.code !== 0) ctx.ui.notify(`Failed to diff ${fileInfo.file}`, "error");

					// Cleanup after Zed reads it
					setTimeout(() => pi.exec("rm", ["-f", tmpFile], { cwd: ctx.cwd }), 5000);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to open ${fileInfo.file}: ${message}`, "error");
				}
			};

			// Show file picker with SelectList
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const container = new Container();

				// Top border
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				// Title
				container.addChild(new Text(theme.fg("accent", theme.bold(" Select file to diff")), 0, 0));

				// Build select items with colored status
				const items: SelectItem[] = files.map((f) => {
					let statusColor: string;
					switch (f.status) {
						case "M":
							statusColor = theme.fg("warning", f.status);
							break;
						case "A":
							statusColor = theme.fg("success", f.status);
							break;
						case "D":
							statusColor = theme.fg("error", f.status);
							break;
						case "?":
							statusColor = theme.fg("muted", f.status);
							break;
						default:
							statusColor = theme.fg("dim", f.status);
					}
					return {
						value: f,
						label: `${statusColor} ${f.file}`,
					};
				});

				const visibleRows = Math.min(files.length, 15);
				let currentIndex = 0;

				const selectList = new SelectList(items, visibleRows, {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => t, // Keep existing colors
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});
				selectList.onSelect = (item) => {
					void openSelected(item.value as FileInfo);
				};
				selectList.onCancel = () => done();
				selectList.onSelectionChange = (item) => {
					currentIndex = items.indexOf(item);
				};
				container.addChild(selectList);

				// Help text
				container.addChild(
					new Text(theme.fg("dim", " ↑↓ navigate • ←→ page • enter open • esc close"), 0, 0),
				);

				// Bottom border
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						// Add paging with left/right
						if (matchesKey(data, Key.left)) {
							// Page up - clamp to 0
							currentIndex = Math.max(0, currentIndex - visibleRows);
							selectList.setSelectedIndex(currentIndex);
						} else if (matchesKey(data, Key.right)) {
							// Page down - clamp to last
							currentIndex = Math.min(items.length - 1, currentIndex + visibleRows);
							selectList.setSelectedIndex(currentIndex);
						} else {
							selectList.handleInput(data);
						}
						tui.requestRender();
					},
				};
			});
		},
	});
}
