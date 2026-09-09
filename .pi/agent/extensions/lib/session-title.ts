const DEFAULT_MAX_WORDS = 6;
const DEFAULT_MAX_CHARS = 48;

function stripAnsi(value: string): string {
	return value
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, " ")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ")
		.replace(/\u001b[@-_]/g, " ");
}

export function sanitizeTitleText(value: string): string {
	return stripAnsi(value)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function titleizeSessionName(
	text: string,
	options: {
		maxWords?: number;
		maxChars?: number;
	} = {},
): string | null {
	const maxWords = options.maxWords ?? DEFAULT_MAX_WORDS;
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	const words = sanitizeTitleText(text)
		.replace(/["'`]/g, "")
		.replace(/[.!?]+$/g, "")
		.split(" ")
		.filter(Boolean)
		.slice(0, maxWords);
	if (words.length === 0) return null;
	const name = words
		.map((word) => {
			if (/^[A-Z0-9]{2,}$/.test(word) || word.includes("-") || word.includes("/")) return word;
			return word.charAt(0).toUpperCase() + word.slice(1);
		})
		.join(" ");
	if (name.length <= maxChars) return name;
	return `${name.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function heuristicSessionName(
	text: string,
	options: {
		maxWords?: number;
		maxChars?: number;
	} = {},
): string | null {
	const firstLine = text
		.split(/\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	return titleizeSessionName(firstLine ?? text, options);
}

export function cleanGeneratedSessionName(
	raw: string,
	options: {
		maxWords?: number;
		maxChars?: number;
	} = {},
): string | null {
	const firstLine = raw
		.split(/\n/)
		.map((line) => sanitizeTitleText(line))
		.find((line) => line.length > 0);
	if (!firstLine) return null;
	return titleizeSessionName(firstLine.replace(/^(title|name)\s*:\s*/i, ""), options);
}
