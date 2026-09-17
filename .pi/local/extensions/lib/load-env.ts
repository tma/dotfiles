import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SKIP_KEYS = new Set(["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_LOCAL_DIR", "PI_LOCAL_ENV"]);

export type LoadedEnv = {
	path: string | null;
	keys: string[];
};

function stripQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
		(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
	) {
		return value.slice(1, -1);
	}
	return value;
}

export function parseDotEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const cleaned = line.replace(/^export\s+/, "");
		const eq = cleaned.indexOf("=");
		if (eq <= 0) continue;
		const key = cleaned.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		out[key] = stripQuotes(cleaned.slice(eq + 1).trim());
	}
	return out;
}

export function applyDotEnv(text: string): string[] {
	const applied: string[] = [];
	for (const [key, value] of Object.entries(parseDotEnv(text))) {
		if (SKIP_KEYS.has(key)) continue;
		process.env[key] = value;
		applied.push(key);
	}
	return applied;
}

export function loadLocalEnv(cwd = process.cwd()): LoadedEnv {
	const explicit = process.env.PI_LOCAL_ENV?.trim();
	const candidates = explicit ? [path.resolve(explicit)] : [path.resolve(cwd, ".env")];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			if (!statSync(candidate).isFile()) continue;
			const keys = applyDotEnv(readFileSync(candidate, "utf8"));
			return { path: candidate, keys };
		} catch {
			continue;
		}
	}
	return { path: null, keys: [] };
}
