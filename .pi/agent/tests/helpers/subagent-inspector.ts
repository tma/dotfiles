import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import * as path from "node:path";
import * as os from "node:os";

const source = await readFile(new URL("../../extensions/lib/subagent-inspector.ts", import.meta.url), "utf8");

class SelectList {
	items: any[];
	selected = 0;
	onSelect?: (item: any) => void;
	constructor(items: any[]) { this.items = items; }
	getSelectedItem() { return this.items[this.selected]; }
	setSelectedIndex(index: number) { this.selected = index; }
	render() { return this.items.map((item) => item.label); }
	handleInput(data: string) {
		if (data === "down") this.selected = Math.min(this.items.length - 1, this.selected + 1);
		if (data === "up") this.selected = Math.max(0, this.selected - 1);
		if (data === "enter") this.onSelect?.(this.getSelectedItem());
	}
}

class Box {
	paddingX: number;
	paddingY: number;
	children: any[] = [];
	constructor(paddingX: number, paddingY: number) { this.paddingX = paddingX; this.paddingY = paddingY; }
	addChild(child: any) { this.children.push(child); }
	render(width: number) {
		const padding = " ".repeat(this.paddingX);
		const innerWidth = Math.max(0, width - this.paddingX * 2);
		const blank = Array(this.paddingY).fill(" ".repeat(width));
		const content = this.children.flatMap((child) => child.render(innerWidth))
			.map((line: string) => padding + line.padEnd(innerWidth) + padding);
		return [...blank, ...content, ...blank];
	}
}

class DynamicBorder {
	color: (text: string) => string;
	constructor(color: (text: string) => string) { this.color = color; }
	render(width: number) { return [this.color("─".repeat(width))]; }
}

export function loadInspector(overrides: Record<string, any> = {}) {
	const deps = {
		createHash, fs, path, os, Box, DynamicBorder,
		getAgentDir: () => "/tmp",
		SessionManager: {},
		matchesKey: (data: string, key: string) => data === key,
		SelectList,
		truncateToWidth: (text: string, width: number) => [...text].slice(0, width).join(""),
		wrapTextWithAnsi: (text: string, width: number) => text.split("\n").flatMap((line) => {
			const chars = [...line];
			const lines: string[] = [];
			for (let index = 0; index < chars.length; index += width) lines.push(chars.slice(index, index + width).join(""));
			return lines.length ? lines : [""];
		}),
		...overrides,
	};
	const code = stripTypeScriptTypes(source.replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, ""));
	const exports = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((match) => match[1]);
	return new Function("deps", `${Object.keys(deps).map((name) => `const ${name} = deps.${name};`).join("\n")}\n${code}\nreturn { ${exports.join(", ")} };`)(deps);
}

export const inspector = loadInspector();

export function fakeChildSession() {
	return { getSessionFile: () => "/tmp/native-child.jsonl", appendCustomEntry: () => {} };
}
