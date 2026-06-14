import type { CitecheckOptions, ConversionMode } from "./types.ts";

export const USAGE = `Usage:
  /citecheck <pdf-file-or-folder> [options]
  /citecheck stop

Checks PDF references for likely hallucinations using Docling + GPT Web Search.

Subcommands:
  stop                       Stop the active /citecheck run and terminate launched process trees.

Options:
  --recursive                 Recurse into folders when discovering PDFs/Markdown.
  --out <dir>                 Output directory. Default: .pi/citecheck/<timestamp>/
  --conversion <mode>         dual | vlm | standard. Default: dual.
  --from-md                   Treat input as Markdown and skip Docling.
  --refs-page <n>             For PDFs, extract exactly page n (1-based) as the references page.
  --references-page <n>       Alias for --refs-page.
  --max-concurrency <n>       Concurrent web-search checks. Default: 2.
  --max-refs <n>              Check only the first n references.
  --yes, -y                   Skip confirmation before many web-search calls.
  --help, -h                  Show this help.`;

export interface ParseResult {
	ok: boolean;
	help?: boolean;
	options?: CitecheckOptions;
	error?: string;
}

export function parseCitecheckArgs(input: string): ParseResult {
	const tokens = tokenize(input);
	if (tokens.length === 0) {
		return { ok: false, error: "Missing input path.\n\n" + USAGE };
	}

	const options: CitecheckOptions = {
		input: "",
		recursive: false,
		conversion: "dual",
		fromMd: false,
		maxConcurrency: 2,
		yes: false,
		searchTimeoutMs: 120_000,
		doclingTimeoutMs: 30 * 60_000,
	};

	const positional: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--help" || token === "-h") {
			return { ok: true, help: true };
		}
		if (token === "--recursive") {
			options.recursive = true;
			continue;
		}
		if (token === "--no-recursive") {
			options.recursive = false;
			continue;
		}
		if (token === "--from-md") {
			options.fromMd = true;
			continue;
		}
		if (token === "--yes" || token === "-y") {
			options.yes = true;
			continue;
		}

		const [name, inlineValue] = splitLongOption(token);
		if (name === "--out") {
			const value = readOptionValue(name, inlineValue, tokens, i);
			if (!value.ok) return { ok: false, error: value.error };
			options.outDir = value.value;
			i = value.index;
			continue;
		}
		if (name === "--conversion") {
			const value = readOptionValue(name, inlineValue, tokens, i);
			if (!value.ok) return { ok: false, error: value.error };
			if (!isConversionMode(value.value)) {
				return { ok: false, error: `Invalid --conversion value: ${value.value}. Expected dual, vlm, or standard.` };
			}
			options.conversion = value.value;
			i = value.index;
			continue;
		}
		if (name === "--max-concurrency") {
			const raw = readOptionValue(name, inlineValue, tokens, i);
			if (!raw.ok) return { ok: false, error: raw.error };
			const value = parsePositiveInteger(raw.value, name);
			if (typeof value === "string") return { ok: false, error: value };
			options.maxConcurrency = value;
			i = raw.index;
			continue;
		}
		if (name === "--refs-page" || name === "--references-page") {
			const raw = readOptionValue(name, inlineValue, tokens, i);
			if (!raw.ok) return { ok: false, error: raw.error };
			const value = parsePositiveInteger(raw.value, name);
			if (typeof value === "string") return { ok: false, error: value };
			options.refsPage = value;
			i = raw.index;
			continue;
		}
		if (name === "--max-refs") {
			const raw = readOptionValue(name, inlineValue, tokens, i);
			if (!raw.ok) return { ok: false, error: raw.error };
			const value = parsePositiveInteger(raw.value, name);
			if (typeof value === "string") return { ok: false, error: value };
			options.maxRefs = value;
			i = raw.index;
			continue;
		}
		if (name === "--search-timeout-ms") {
			const raw = readOptionValue(name, inlineValue, tokens, i);
			if (!raw.ok) return { ok: false, error: raw.error };
			const value = parsePositiveInteger(raw.value, name);
			if (typeof value === "string") return { ok: false, error: value };
			options.searchTimeoutMs = value;
			i = raw.index;
			continue;
		}
		if (name === "--docling-timeout-ms") {
			const raw = readOptionValue(name, inlineValue, tokens, i);
			if (!raw.ok) return { ok: false, error: raw.error };
			const value = parsePositiveInteger(raw.value, name);
			if (typeof value === "string") return { ok: false, error: value };
			options.doclingTimeoutMs = value;
			i = raw.index;
			continue;
		}
		if (token.startsWith("-")) {
			return { ok: false, error: `Unknown option: ${token}\n\n${USAGE}` };
		}
		positional.push(token);
	}

	if (positional.length === 0) {
		return { ok: false, error: "Missing input path.\n\n" + USAGE };
	}
	if (positional.length > 1) {
		return { ok: false, error: `Expected one input path, got ${positional.length}: ${positional.join(", ")}` };
	}

	options.input = positional[0]!;
	return { ok: true, options };
}

function splitLongOption(token: string): [string, string | undefined] {
	const eq = token.indexOf("=");
	if (eq === -1) return [token, undefined];
	return [token.slice(0, eq), token.slice(eq + 1)];
}

function readOptionValue(
	name: string,
	inlineValue: string | undefined,
	tokens: string[],
	index: number,
): { ok: true; value: string; index: number } | { ok: false; error: string } {
	if (inlineValue !== undefined) return { ok: true, value: inlineValue, index };
	const next = tokens[index + 1];
	if (next === undefined || next.startsWith("--")) {
		return { ok: false, error: `${name} requires a value` };
	}
	return { ok: true, value: next, index: index + 1 };
}

function parsePositiveInteger(value: string, optionName: string): number | string {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return `${optionName} expects a positive integer, got: ${value}`;
	}
	return parsed;
}

function isConversionMode(value: string): value is ConversionMode {
	return value === "dual" || value === "vlm" || value === "standard";
}

export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaping) current += "\\";
	if (current.length > 0) tokens.push(current);
	return tokens;
}
