/**
 * One-line notification previews for Pi runs.
 *
 * The preview leads with the outcome ("Done", "Needs input", "Blocked",
 * "Failed", "Stopped") and an excerpt from the final assistant answer.
 * It reads explicit signals only: a status label such as "Blocked: ..." or a
 * trailing question. It does not try to interpret free-form prose.
 */

export interface AssistantMessageLike {
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

const MAX_PREVIEW_TEXT = 64;
const READY = "Ready for input";
const SEPARATOR = " · ";

const TERMINAL_ESCAPES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;
// A leading status word followed by ":" or "·", or by a spaced dash (so "Done-ish" is not a label).
const STATUS_LABEL = /^(failed|blocked|blocker|needs? input|stopped|done)(?:\s*[:·]|\s+[-–—])\s*(.*)$/i;
// Labels in priority order: any non-Done label wins over Done, so a preview never claims success over a reported problem.
const STATUS_LABELS: Array<[label: string, pattern: RegExp]> = [
	["Failed", /^failed$/i],
	["Blocked", /^blocke[dr]$/i],
	["Needs input", /^needs? input$/i],
	["Stopped", /^stopped$/i],
	["Done", /^done$/i],
];
const REDUNDANT_LABEL = /^(?:changed|summary|result|outcome)(?:\s*:|\s+[-–—])\s*/i;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function sanitizeNotificationText(text: string, maxChars = MAX_PREVIEW_TEXT): string {
	const clean = text
		.replace(TERMINAL_ESCAPES, "")
		.replace(BIDI_CONTROLS, "")
		.replace(CONTROL_CHARS, " ")
		.replace(/\s+/g, " ")
		.trim();
	const graphemes = Array.from(segmenter.segment(clean), (part) => part.segment);
	if (graphemes.length <= maxChars) return clean;
	return `${graphemes.slice(0, Math.max(0, maxChars - 1)).join("").trimEnd()}…`;
}

/** PowerShell treats ASCII and typographic single quotes as delimiters; doubling escapes each one. */
export function escapePowerShellSingleQuoted(text: string): string {
	return text.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&");
}

export function completionPreview(message: AssistantMessageLike | undefined): string {
	if (message?.stopReason === "aborted") return "Stopped · Run interrupted";
	if (message?.stopReason === "error") {
		const firstErrorLine = (message.errorMessage ?? "").replace(TERMINAL_ESCAPES, "").split(/\r?\n/).find((line) => line.trim());
		return withLabel("Failed", firstErrorLine ?? "Run error");
	}
	if (message?.stopReason !== "stop") return READY;

	const lines = meaningfulLines(assistantText(message.content));
	if (lines.length === 0) return READY;

	const labeled = explicitStatus(lines);
	if (labeled && labeled.label !== "Done") return withLabel(labeled.label, labeled.text);

	const lastLine = lines[lines.length - 1];
	if (lastLine.endsWith("?")) return withLabel("Needs input", lastLine);

	return withLabel("Done", labeled?.text ?? lines[0].replace(REDUNDANT_LABEL, ""));
}

function explicitStatus(lines: string[]): { label: string; text: string } | undefined {
	const matches = lines.flatMap((line) => {
		const match = line.match(STATUS_LABEL);
		return match ? [{ word: match[1], text: match[2] }] : [];
	});
	for (const [label, pattern] of STATUS_LABELS) {
		const match = matches.find(({ word }) => pattern.test(word));
		if (match) return { label, text: match.text };
	}
	return undefined;
}

function withLabel(label: string, text: string): string {
	const body = sanitizeNotificationText(text.replace(/\.$/, ""));
	return body ? `${label}${SEPARATOR}${body}` : label;
}

function assistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function meaningfulLines(text: string): string[] {
	const lines: string[] = [];
	let inFence = false;
	for (const rawLine of text.replace(TERMINAL_ESCAPES, "").split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (/^(?:```|~~~)/.test(trimmed)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || isStructuralLine(trimmed)) continue;

		const line = sanitizeNotificationText(stripInlineMarkdown(trimmed), Number.POSITIVE_INFINITY);
		if (/[\p{L}\p{N}]/u.test(line) && !line.endsWith(":")) lines.push(line);
	}
	return lines;
}

function isStructuralLine(line: string): boolean {
	return line === ""
		|| /^#{1,6}\s/.test(line)
		|| /^\|/.test(line)
		|| /^([-*_])(?:\s*\1){2,}$/.test(line);
}

function stripInlineMarkdown(line: string): string {
	return line
		.replace(/^(?:>\s*)+/, "")
		.replace(/^(?:[-*+]|\d+[.)])\s+/, "")
		.replace(/^\[[ xX]\]\s+/, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\*\*|__|~~/g, "")
		.replace(/(^|[^\p{L}\p{N}])[*_]([^*_]+)[*_](?=[^\p{L}\p{N}]|$)/gu, "$1$2");
}
