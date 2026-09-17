import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SKIP_KEYS = new Set(["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_LOCAL_DIR", "PI_LOCAL_ENV", "PI_LOCAL_LAUNCH_DIR"]);

export type LoadedEnv = {
	path: string | null;
	keys: string[];
	tried: string[];
	error?: string;
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

function unique(paths: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of paths) {
		if (!item || seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}

export function envCandidateDirs(cwd = process.cwd()): string[] {
	return unique(
		[process.env.PI_LOCAL_LAUNCH_DIR, process.env.PWD, cwd, process.cwd()].filter((dir): dir is string => Boolean(dir?.trim())),
	);
}

export function envCandidateFiles(cwd = process.cwd()): string[] {
	const explicit = process.env.PI_LOCAL_ENV?.trim();
	if (explicit) return [path.resolve(explicit)];
	return envCandidateDirs(cwd).map((dir) => path.resolve(dir, ".env"));
}

export function describeEnvDir(dir: string): string {
	try {
		const hits = readdirSync(dir).filter((name) => name === ".env" || name.startsWith(".env."));
		if (hits.length === 0) return `${dir} has no .env*`;
		return `${dir} has ${hits.join(", ")}`;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return `${dir} unreadable (${detail})`;
	}
}

export function loadLocalEnv(cwd = process.cwd()): LoadedEnv {
	const tried = envCandidateFiles(cwd);
	const errors: string[] = [];
	for (const candidate of tried) {
		try {
			if (!existsSync(candidate)) continue;
			if (!statSync(candidate).isFile()) {
				errors.push(`${candidate} is not a file`);
				continue;
			}
			const keys = applyDotEnv(readFileSync(candidate, "utf8"));
			return { path: candidate, keys, tried };
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			errors.push(`${candidate}: ${detail}`);
		}
	}
	const listing = unique([...(process.env.PI_LOCAL_LAUNCH_DIR ? [process.env.PI_LOCAL_LAUNCH_DIR] : []), cwd]).map(describeEnvDir);
	return {
		path: null,
		keys: [],
		tried,
		error: [...errors, ...listing].join("; ") || undefined,
	};
}
