import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { throwIfAborted } from "./cancel.ts";
import type { CommandInfo, ExecFn, NormalizedReference, ReferenceEntry, SearchEvidence } from "./types.ts";
import { commandExists, ensureDir, truncateForReport, writeJson, writeText } from "./utils.ts";

export async function locateNativeWebSearch(getCommands?: () => CommandInfo[]): Promise<string | undefined> {
	const commands = getCommands?.() ?? [];
	const candidates: string[] = [];
	for (const command of commands) {
		const path = command.sourceInfo?.baseDir ?? command.sourceInfo?.path;
		if (!path) continue;
		if (command.source === "skill" && command.name.startsWith("native-web-search")) {
			candidates.push(path);
		}
		if (path.includes("native-web-search")) {
			candidates.push(path);
		}
	}

	for (const candidate of candidates) {
		const dir = candidate.endsWith("SKILL.md") ? dirname(candidate) : candidate;
		const script = join(dir, "search.mjs");
		if (existsSync(script)) return script;
	}

	const home = process.env.HOME ?? "";
	const fallbacks = [
		join(home, ".pi/agent/skills/native-web-search/search.mjs"),
		join(home, ".agents/skills/native-web-search/search.mjs"),
		join(home, ".pi/agent/git/github.com/mitsuhiko/agent-stuff/skills/native-web-search/search.mjs"),
	];
	return fallbacks.find((path) => existsSync(path));
}

export async function checkReferencesWithSearch(
	references: Array<{ entry: ReferenceEntry; normalized: NormalizedReference; conversionNotes: string[] }>,
	outDir: string,
	paperSlug: string,
	exec: ExecFn,
	searchScript: string,
	maxConcurrency: number,
	searchTimeoutMs: number,
	signal?: AbortSignal,
	onProgress?: (
		done: number,
		total: number,
		reference: { entry: ReferenceEntry; normalized: NormalizedReference; conversionNotes: string[] },
		evidence: SearchEvidence,
	) => void,
): Promise<SearchEvidence[]> {
	throwIfAborted(signal);
	if (!(await commandExists(exec, "node"))) {
		throwIfAborted(signal);
		throw new Error("node command not found; cannot run native-web-search/search.mjs.");
	}

	const rawDir = join(outDir, "raw-search", paperSlug);
	await ensureDir(rawDir);
	let completed = 0;
	return mapLimit(references, Math.max(1, maxConcurrency), async (reference) => {
		throwIfAborted(signal);
		const evidence = await runOneSearch(reference.entry, reference.normalized, rawDir, exec, searchScript, searchTimeoutMs, signal);
		completed++;
		onProgress?.(completed, references.length, reference, evidence);
		return evidence;
	});
}

async function runOneSearch(
	entry: ReferenceEntry,
	normalized: NormalizedReference,
	rawDir: string,
	exec: ExecFn,
	searchScript: string,
	searchTimeoutMs: number,
	signal?: AbortSignal,
): Promise<SearchEvidence> {
	const query = normalized.query;
	const purpose = buildPurpose(entry, normalized);
	const prefix = join(rawDir, `ref-${String(entry.index).padStart(3, "0")}`);
	const args = [searchScript, query, "--purpose", purpose, "--provider", "openai-codex", "--json", "--timeout", String(searchTimeoutMs)];
	throwIfAborted(signal);
	const result = await exec("node", args, { signal, timeout: searchTimeoutMs + 15_000 });
	throwIfAborted(signal);
	const rawText = `${result.stdout || ""}${result.stderr ? `\n\n[stderr]\n${result.stderr}` : ""}`.trim();
	await writeText(`${prefix}.stdout.txt`, rawText + "\n");

	let resultText = rawText;
	let rawJsonPath: string | undefined;
	try {
		const parsed = JSON.parse(result.stdout || "{}");
		rawJsonPath = `${prefix}.json`;
		await writeJson(rawJsonPath, parsed);
		if (typeof parsed.result === "string") resultText = parsed.result;
	} catch {
		// Keep raw stdout/stderr as evidence.
	}

	if (result.code !== 0) {
		return {
			query,
			purpose,
			rawJsonPath,
			rawTextPath: `${prefix}.stdout.txt`,
			resultText: truncateForReport(resultText),
			exitCode: result.code,
			error: `native-web-search failed with exit code ${result.code}`,
		};
	}

	return {
		query,
		purpose,
		rawJsonPath,
		rawTextPath: `${prefix}.stdout.txt`,
		resultText: truncateForReport(resultText),
		exitCode: result.code,
	};
}

function buildPurpose(entry: ReferenceEntry, normalized: NormalizedReference): string {
	const fields = [
		normalized.title ? `Title: ${normalized.title}` : undefined,
		normalized.authors ? `Authors: ${normalized.authors}` : undefined,
		normalized.year ? `Year: ${normalized.year}` : undefined,
		normalized.doi ? `DOI: ${normalized.doi}` : undefined,
		normalized.url ? `URL: ${normalized.url}` : undefined,
		normalized.arxivId ? `arXiv: ${normalized.arxivId}` : undefined,
	]
		.filter(Boolean)
		.join("\n");

	return `Verify whether this bibliographic reference corresponds to a real publication, and flag likely AI-hallucinated or mismatched citations. Compare title, authors, year, venue, DOI, and URL when available, but evaluate the Original reference text rather than the heuristic extracted fields. Treat initials vs full given names, abbreviated venues, minor punctuation/hyphenation differences, and an author list shortened with et al. as valid when they identify the same work. Do not call a citation mismatch solely because the heuristic extracted fields are incomplete, malformed, or omit coauthors. Use mismatch only when the original reference materially points to a different work or has a wrong title, DOI, year, venue, or page range. Do not call something hallucinated merely because evidence is sparse; use unverified or needs-manual-review for weak evidence.\n\nReturn exactly this compact structure first:\nVerdict: one of valid | likely-valid | mismatch | unverified | likely-hallucinated | needs-manual-review\nConfidence: number from 0 to 1\nReason: one concise sentence\nEvidence URLs: full URLs separated by spaces\n\nOriginal reference #${entry.index}:\n${entry.raw}\n\nHeuristic extracted fields, which may be incomplete and should not by themselves cause a mismatch verdict:\n${fields || "No reliable fields extracted."}`;
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function readSearchEvidence(path: string): Promise<string> {
	return readFile(path, "utf8");
}
