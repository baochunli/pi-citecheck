import type { ReferenceEntry, ReferenceSection } from "./types.ts";

const REFERENCE_HEADING_WORDS = [
	"references",
	"bibliography",
	"works cited",
	"literature cited",
	"reference",
];

interface HeadingMatch {
	line: number;
	level: number;
	text: string;
	markdown: boolean;
}

export function extractReferenceSection(markdown: string): ReferenceSection {
	const normalized = markdown.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	const matches: HeadingMatch[] = [];

	for (let i = 0; i < lines.length; i++) {
		const match = matchReferenceHeading(lines[i] ?? "");
		if (match) matches.push({ ...match, line: i });
	}

	if (matches.length > 0) {
		const chosen = chooseReferenceHeading(matches, lines.length);
		const end = findSectionEnd(lines, chosen.line + 1, chosen.level, chosen.markdown);
		const body = lines.slice(chosen.line, end).join("\n").trim();
		return {
			found: true,
			heading: chosen.text,
			startLine: chosen.line + 1,
			endLine: end,
			markdown: body,
			warnings: [],
		};
	}

	const fallback = fallbackReferenceTail(lines);
	if (fallback) {
		return {
			found: false,
			startLine: fallback.start + 1,
			endLine: lines.length,
			markdown: lines.slice(fallback.start).join("\n").trim(),
			warnings: [
				"No explicit References/Bibliography heading found; used a best-effort tail section containing reference-like entries.",
			],
		};
	}

	return {
		found: false,
		markdown: "",
		warnings: ["No references section could be extracted."],
	};
}

function matchReferenceHeading(line: string): Omit<HeadingMatch, "line"> | undefined {
	let text = line.trim();
	if (!text) return undefined;
	text = text.replace(/^>+\s*/, "").trim();
	text = text.replace(/^\*\*(.+)\*\*$/, "$1").trim();
	text = text.replace(/^__(.+)__$/, "$1").trim();

	const markdown = /^(#{1,6})\s+/.exec(text);
	let level = 99;
	if (markdown) {
		level = markdown[1]!.length;
		text = text.slice(markdown[0].length).trim();
	}

	text = text
		.replace(/<a\s+[^>]*><\/a>/gi, "")
		.replace(/\s*\{#[^}]+\}\s*$/g, "")
		.replace(/[#:：]+$/g, "")
		.replace(/^\d+(?:\.\d+)*\s+/, "")
		.replace(/^[IVXLC]+\.?\s+/i, "")
		.trim();

	const canonical = text.toLowerCase().replace(/\s+/g, " ");
	if (!REFERENCE_HEADING_WORDS.includes(canonical)) return undefined;
	return { level, text, markdown: Boolean(markdown) };
}

function chooseReferenceHeading(matches: HeadingMatch[], totalLines: number): HeadingMatch {
	// Prefer the first plausible references heading in the latter half. This avoids
	// table-of-contents mentions while still supporting appendices after references.
	const later = matches.filter((m) => m.line >= totalLines * 0.45);
	return later[0] ?? matches[matches.length - 1]!;
}

function findSectionEnd(lines: string[], start: number, level: number, markdown: boolean): number {
	for (let i = start; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim());
		if (heading && heading[1]!.length <= level) return i;

		if (!markdown) {
			const plain = line.trim();
			if (/^(appendix|acknowledg(e)?ments?|supplementary materials?|about the authors)\b/i.test(plain)) {
				return i;
			}
		}
	}
	return lines.length;
}

function fallbackReferenceTail(lines: string[]): { start: number } | undefined {
	const startAt = Math.max(0, Math.floor(lines.length * 0.55));
	for (let i = startAt; i < lines.length; i++) {
		let hits = 0;
		for (let j = i; j < Math.min(lines.length, i + 25); j++) {
			if (isReferenceStart(lines[j] ?? "")) hits++;
		}
		if (hits >= 3) return { start: i };
	}
	return undefined;
}

export function splitReferences(sectionMarkdown: string): ReferenceEntry[] {
	const withoutHeading = stripReferenceHeading(sectionMarkdown);
	const lines = withoutHeading
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !/^[-*_]{3,}$/.test(line));

	const entries: Array<{ label?: string; chunks: string[] }> = [];
	let current: { label?: string; chunks: string[] } | undefined;
	let numberedStarts = 0;

	for (const line of lines) {
		const start = parseNumberedStart(line);
		if (start) {
			numberedStarts++;
			if (current) entries.push(current);
			current = { label: start.label, chunks: [start.text] };
			continue;
		}

		const authorStart = isAuthorYearStart(line);
		if (authorStart && current && current.chunks.join(" ").length > 60) {
			entries.push(current);
			current = { chunks: [line] };
			continue;
		}

		if (!current) current = { chunks: [line] };
		else current.chunks.push(line);
	}
	if (current) entries.push(current);

	let cleanEntries = entries.map((entry) => cleanEntry(entry.label, entry.chunks.join(" "))).filter(Boolean) as string[];

	if (numberedStarts < 2 && cleanEntries.length <= 2) {
		cleanEntries = splitParagraphFallback(withoutHeading);
	}

	return cleanEntries.map((raw, index) => ({ index: index + 1, raw }));
}

function stripReferenceHeading(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 0 && matchReferenceHeading(lines[0]!)) {
		return lines.slice(1).join("\n");
	}
	return markdown;
}

function parseNumberedStart(line: string): { label: string; text: string } | undefined {
	const match = /^\s*(?:\[(\d{1,4})\]|(\d{1,4})[.)]|(?:[-*•])\s+)\s*(.+)$/.exec(line);
	if (!match) return undefined;
	const label = match[1] ?? match[2] ?? "•";
	const text = match[3]!.trim();
	if (text.length < 8) return undefined;
	return { label, text };
}

function isReferenceStart(line: string): boolean {
	return Boolean(parseNumberedStart(line)) || isAuthorYearStart(line);
}

function isAuthorYearStart(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length < 30) return false;
	if (!/\b(?:19|20)\d{2}[a-z]?\b/.test(trimmed)) return false;
	if (!/^[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+,/.test(trimmed)) return false;
	return true;
}

function cleanEntry(label: string | undefined, text: string): string | undefined {
	let cleaned = text
		.replace(/\s+/g, " ")
		.replace(/\s+([,.;:])/g, "$1")
		.replace(/-\s+/g, "")
		.trim();
	if (label && label !== "•") cleaned = `[${label}] ${cleaned}`;
	if (cleaned.length < 20) return undefined;
	return cleaned;
}

function splitParagraphFallback(markdown: string): string[] {
	return markdown
		.split(/\n\s*\n+/)
		.map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
		.filter((paragraph) => paragraph.length >= 25 && /\b(?:19|20)\d{2}\b|\b10\.\d{4,9}\//i.test(paragraph));
}

export function referenceKey(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\bdoi\s*:?\s*/g, " ")
		.replace(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\b\d{1,3}\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function tokenJaccard(a: string, b: string): number {
	const aa = new Set(referenceKey(a).split(" ").filter((token) => token.length > 2));
	const bb = new Set(referenceKey(b).split(" ").filter((token) => token.length > 2));
	if (aa.size === 0 || bb.size === 0) return 0;
	let intersection = 0;
	for (const token of aa) if (bb.has(token)) intersection++;
	return intersection / (aa.size + bb.size - intersection);
}
