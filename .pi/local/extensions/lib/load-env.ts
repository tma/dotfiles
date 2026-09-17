import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, type Stats } from "node:fs";
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

function describeStat(st: Stats): string {
	const kinds = [
		st.isFile() && "file",
		st.isDirectory() && "directory",
		st.isSymbolicLink() && "symlink",
		st.isSocket() && "socket",
		st.isFIFO() && "fifo",
		st.isBlockDevice() && "block",
		st.isCharacterDevice() && "char",
	].filter(Boolean);
	return `${kinds.join("|") || "unknown"} mode=${st.mode.toString(8)} size=${st.size}`;
}

function readEnvFile(filePath: string): { ok: true; path: string; keys: string[] } | { ok: false; error: string } {
	try {
		const keys = applyDotEnv(readFileSync(filePath, "utf8"));
		return { ok: true, path: filePath, keys };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `${filePath}: ${detail}` };
	}
}

function readEnvCandidate(
	candidate: string,
	depth = 0,
): { ok: true; path: string; keys: string[] } | { ok: false; error?: string } {
	if (depth > 4) return { ok: false, error: `${candidate}: too many .env links` };
	if (!existsSync(candidate)) return { ok: false };

	let lst: Stats;
	try {
		lst = lstatSync(candidate);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `${candidate}: ${detail}` };
	}

	if (lst.isSymbolicLink()) {
		try {
			return readEnvCandidate(realpathSync(candidate), depth + 1);
		} catch (error) {
			const result = readEnvFile(candidate);
			if (result.ok) return result;
			const detail = error instanceof Error ? error.message : String(error);
			return { ok: false, error: `${candidate} (${describeStat(lst)}): ${detail}` };
		}
	}

	if (lst.isDirectory()) {
		const nested = path.join(candidate, ".env");
		if (nested !== candidate && existsSync(nested)) return readEnvCandidate(nested, depth + 1);
		return { ok: false, error: `${candidate} is a directory` };
	}

	const result = readEnvFile(candidate);
	if (result.ok) return result;
	return { ok: false, error: `${candidate} (${describeStat(lst)}): ${result.error}` };
}

export function loadLocalEnv(cwd = process.cwd()): LoadedEnv {
	const tried = envCandidateFiles(cwd);
	const errors: string[] = [];
	for (const candidate of tried) {
		const result = readEnvCandidate(candidate);
		if (result.ok) return { path: result.path, keys: result.keys, tried };
		if (result.error) errors.push(result.error);
	}
	const listing = unique([...(process.env.PI_LOCAL_LAUNCH_DIR ? [process.env.PI_LOCAL_LAUNCH_DIR] : []), cwd]).map(describeEnvDir);
	return {
		path: null,
		keys: [],
		tried,
		error: [...errors, ...listing].join("; ") || undefined,
	};
}
