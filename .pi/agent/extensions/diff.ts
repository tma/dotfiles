/**
 * Diff Extension
 *
 * /diff — interactive picker for git-changed files, opens diffs in Zed.
 *   - Enter: open selected file's diff
 *   - a: open all diffs at once
 *   - Esc: close
 *
 * /diff all — open all changed files in Zed's diff view directly (no picker).
 *
 * Temp files (HEAD versions for Zed --diff) use a per-process directory
 * that's cleaned up on process exit and at the start of each invocation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

// ── Temp file management ────────────────────────────────────────────

const DIFF_TMP_DIR = path.join(os.tmpdir(), `pi-diff-${process.pid}`);

function cleanTmpDir(): void {
	try { rmSync(DIFF_TMP_DIR, { recursive: true, force: true }); } catch {}
}

function ensureTmpDir(): void {
	cleanTmpDir();
	mkdirSync(DIFF_TMP_DIR, { recursive: true });
}

// Clean up on process exit
process.on("exit", cleanTmpDir);

function writeTmpFile(name: string, content: string): string {
	const safeName = name.replace(/[/\\]/g, "-");
	const tmpPath = path.join(DIFF_TMP_DIR, `${Date.now()}-${safeName}`);
	writeFileSync(tmpPath, content, "utf-8");
	return tmpPath;
}

// ── Types ───────────────────────────────────────────────────────────

interface FileInfo {
	status: string;
	file: string;
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

	async function getChangedFiles(cwd: string): Promise<FileInfo[] | null> {
		const result = await pi.exec("git", ["status", "--porcelain"], { cwd });
		if (result.code !== 0) return null;
		if (!result.stdout?.trim()) return [];

		const files: FileInfo[] = [];
		for (const line of result.stdout.split("\n")) {
			if (line.length < 4) continue;
			const statusCode = line.slice(0, 2);
			const file = line.slice(2).trimStart();

			let status: string;
			if (statusCode.includes("M")) status = "M";
			else if (statusCode.includes("A")) status = "A";
			else if (statusCode.includes("D")) status = "D";
			else if (statusCode.includes("?")) status = "?";
			else if (statusCode.includes("R")) status = "R";
			else if (statusCode.includes("C")) status = "C";
			else status = statusCode.trim() || "~";

			files.push({ status, file });
		}
		return files;
	}

	function getHeadContent(file: string, cwd: string): string {
		try {
			return execFileSync("git", ["show", `HEAD:${file}`], { cwd, encoding: "utf-8", timeout: 5000 });
		} catch {
			return "";
		}
	}

	async function openDiff(file: FileInfo, cwd: string): Promise<void> {
		try {
			if (file.status === "?" || file.status === "A") {
				await pi.exec("zed", [file.file], { cwd });
				return;
			}
			const headContent = getHeadContent(file.file, cwd);
			const tmpFile = writeTmpFile(path.basename(file.file), headContent);
			const r = await pi.exec("zed", ["--diff", tmpFile, file.file], { cwd });
			if (r.code !== 0) throw new Error(`zed exited ${r.code}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to diff ${file.file}: ${msg}`);
		}
	}

	async function openAllDiffs(files: FileInfo[], cwd: string): Promise<{ opened: number; errors: string[] }> {
		ensureTmpDir();
		const args: string[] = [];
		const errors: string[] = [];

		for (const f of files) {
			if (f.status === "D") continue; // Can't open deleted files
			try {
				if (f.status === "?" || f.status === "A") {
					args.push(f.file);
				} else {
					const headContent = getHeadContent(f.file, cwd);
					const tmpFile = writeTmpFile(path.basename(f.file), headContent);
					args.push("--diff", tmpFile, f.file);
				}
			} catch (err) {
				errors.push(f.file);
			}
		}

		if (args.length > 0) {
			await pi.exec("zed", args, { cwd });
		}

		const opened = files.filter(f => f.status !== "D").length - errors.length;
		return { opened, errors };
	}

	pi.registerCommand("diff", {
		description: "Show git changes and open diffs in Zed (/diff [all])",
		handler: async (args, ctx) => {
			const files = await getChangedFiles(ctx.cwd);
			if (files === null) {
				ctx.ui.notify("git status failed", "error");
				return;
			}
			if (files.length === 0) {
				ctx.ui.notify("No changes in working tree", "info");
				return;
			}

			// /diff all — skip picker, open everything
			if (args?.trim().toLowerCase() === "all") {
				ensureTmpDir();
				const { opened, errors } = await openAllDiffs(files, ctx.cwd);
				if (errors.length > 0) {
					ctx.ui.notify(`Opened ${opened} diff(s), ${errors.length} failed`, "warning");
				} else {
					ctx.ui.notify(`Opened ${opened} diff(s) in Zed`, "info");
				}
				return;
			}

			if (!ctx.hasUI) {
				// Non-interactive fallback: open all
				ensureTmpDir();
				await openAllDiffs(files, ctx.cwd);
				return;
			}

			// Interactive picker
			ensureTmpDir();

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const container = new Container();

				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(
					theme.fg("accent", theme.bold(" Diff ")) + theme.fg("muted", `${files.length} changed`),
					0, 0,
				));

				const items: SelectItem[] = files.map((f) => {
					let statusColor: string;
					switch (f.status) {
						case "M": statusColor = theme.fg("warning", f.status); break;
						case "A": statusColor = theme.fg("success", f.status); break;
						case "D": statusColor = theme.fg("error", f.status); break;
						case "?": statusColor = theme.fg("muted", f.status); break;
						default:  statusColor = theme.fg("dim", f.status);
					}
					return { value: f, label: `${statusColor} ${f.file}` };
				});

				const visibleRows = Math.min(files.length, 15);
				let currentIndex = 0;

				const selectList = new SelectList(items, visibleRows, {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => t,
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});

				selectList.onSelect = (item) => {
					openDiff(item.value as FileInfo, ctx.cwd).catch((err) => {
						ctx.ui.notify(err.message, "error");
					});
				};
				selectList.onCancel = () => done();
				selectList.onSelectionChange = (item) => {
					currentIndex = items.indexOf(item);
				};
				container.addChild(selectList);

				container.addChild(new Text(
					theme.fg("dim", " ↑↓ navigate • ←→ page • enter open • a open all • esc close"),
					0, 0,
				));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						if (matchesKey(data, "a")) {
							openAllDiffs(files, ctx.cwd).then(({ opened, errors }) => {
								if (errors.length > 0) {
									ctx.ui.notify(`Opened ${opened} diff(s), ${errors.length} failed`, "warning");
								} else {
									ctx.ui.notify(`Opened ${opened} diff(s) in Zed`, "info");
								}
							}).catch((err) => {
								ctx.ui.notify(err.message, "error");
							});
							done();
							return;
						}
						if (matchesKey(data, Key.left)) {
							currentIndex = Math.max(0, currentIndex - visibleRows);
							selectList.setSelectedIndex(currentIndex);
						} else if (matchesKey(data, Key.right)) {
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
