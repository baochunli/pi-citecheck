import type { ReferenceEntry, SearchEvidence, Verdict } from "./types.ts";
import { unique } from "./utils.ts";

const ALLOWED: Verdict[] = [
	"valid",
	"likely-valid",
	"mismatch",
	"unverified",
	"likely-hallucinated",
	"needs-manual-review",
];

export interface VerdictResult {
	verdict: Verdict;
	confidence: number;
	reason: string;
	evidenceUrls: string[];
}

export function classifyEvidence(entry: ReferenceEntry, evidence: SearchEvidence | undefined): VerdictResult {
	if (!evidence || evidence.error) {
		return {
			verdict: "needs-manual-review",
			confidence: 0.2,
			reason: evidence?.error ?? "No search evidence was collected.",
			evidenceUrls: [],
		};
	}

	const text = evidence.resultText.trim();
	const parsedVerdict = parseVerdict(text);
	const parsedConfidence = parseConfidence(text);
	const urls = extractUrls(text);
	const reason = parseReason(text) ?? summarizeReason(text, entry.raw);

	if (parsedVerdict) {
		if (parsedVerdict === "mismatch" && (looksLikeExtractionArtifactMismatch(text) || looksLikeBenignBibliographicVariantMismatch(text))) {
			return {
				verdict: "likely-valid",
				confidence: Math.min(parsedConfidence ?? defaultConfidence("likely-valid"), 0.82),
				reason: `Search evidence supports the reference; the reported mismatch appears to be an extraction, abbreviation, or punctuation artifact: ${reason}`,
				evidenceUrls: urls,
			};
		}
		return {
			verdict: parsedVerdict,
			confidence: parsedConfidence ?? defaultConfidence(parsedVerdict),
			reason,
			evidenceUrls: urls,
		};
	}

	const lower = text.toLowerCase();
	if (/\b(doi|title|author|venue|year)s?\b.{0,80}\b(mismatch|does not match|different paper|incorrect)\b/s.test(lower)) {
		return { verdict: "mismatch", confidence: parsedConfidence ?? 0.72, reason, evidenceUrls: urls };
	}
	if (/\b(likely hallucinated|fabricated|not a real publication|appears invented)\b/.test(lower)) {
		return { verdict: "likely-hallucinated", confidence: parsedConfidence ?? 0.8, reason, evidenceUrls: urls };
	}
	if (/\b(could not find|no reliable evidence|not found|unable to verify|no matching publication)\b/.test(lower)) {
		return { verdict: "unverified", confidence: parsedConfidence ?? 0.55, reason, evidenceUrls: urls };
	}
	if (/\b(matches|confirmed|verified|exists|real publication)\b/.test(lower) && urls.length > 0) {
		return { verdict: "likely-valid", confidence: parsedConfidence ?? 0.72, reason, evidenceUrls: urls };
	}
	return { verdict: "needs-manual-review", confidence: parsedConfidence ?? 0.4, reason, evidenceUrls: urls };
}

function looksLikeBenignBibliographicVariantMismatch(text: string): boolean {
	const lower = text.toLowerCase();
	const positiveSameWorkSignals = [
		/\btitle\b.{0,80}\b(?:same|real|match|matches|aligns?|consistent)\b/s,
		/\bvenue\b.{0,80}\b(?:match|matches|aligns?|consistent)\b/s,
		/\bpages?\b.{0,80}\b(?:match|matches|aligns?|consistent)\b/s,
		/\bdoi\b.{0,80}\b(?:resolves|match|matches|aligns?|consistent)\b/s,
		/\bnot\s+(?:a\s+)?(?:title|venue)\s+mismatch\b/s,
	];
	const positiveCount = positiveSameWorkSignals.filter((pattern) => pattern.test(lower)).length;
	const benignVariant =
		/\binitials?\s+(?:vs\.?|versus|rather than|instead of)\s+full\b/s.test(lower) ||
		/\bfull\s+(?:author\s+)?(?:names?|spelling)\b.{0,120}\binitials?\b/s.test(lower) ||
		/\binitials?\b.{0,120}\b(?:acceptable|valid|consistent|same authors?|full author spelling)\b/s.test(lower) ||
		/\bminor\s+(?:punctuation|hyphenation|capitalization)\b/s.test(lower) ||
		/\bhyphenation\b.{0,80}\b(?:difference|differs|variant|minor)\b/s.test(lower);
	const materialMismatch =
		/\b(?:wrong|incorrect)\s+(?:doi|year|page range|pages?)\b/s.test(lower) ||
		/\b(?:doi|year|page range|pages?)\s+(?:mismatch|does not match|is wrong|is incorrect)\b/s.test(lower) ||
		/\bdifferent\s+(?:paper|publication|work|article)\b/s.test(lower);
	return positiveCount >= 2 && benignVariant && !materialMismatch;
}

function looksLikeExtractionArtifactMismatch(text: string): boolean {
	const lower = text.toLowerCase();
	const supportsSameWork =
		/\b(?:publication|paper|article|work)\s+(?:appears\s+|is\s+)?real\b/.test(lower) ||
		/\b(?:title|venue|year|page range|pages?|doi)s?\s+(?:match|matches|matched|consistent|agree|align)\b/.test(lower) ||
		/\b(?:match|matches|matched|consistent|agree|align)\b.{0,80}\b(?:title|venue|year|page range|pages?|doi)s?\b/s.test(lower);
	const extractionArtifact =
		/\bextracted\s+(?:citation|reference|fields?|metadata)\b.{0,140}\b(?:wrong|mismatch|misstates?|truncated|incomplete|malformed|misparsed|drops?|omits?)\b/s.test(lower) ||
		/\b(?:wrong|mismatch|misstates?|truncated|incomplete|malformed|misparsed|drops?|omits?)\b.{0,140}\bextracted\s+(?:citation|reference|fields?|metadata)\b/s.test(lower) ||
		/\b(?:truncated|incomplete|malformed|misparsed|drops?|omits?)\b.{0,120}\b(?:author list|coauthors?|et al\.?|initials?|full names?)\b/s.test(lower) ||
		/\b(?:author list|coauthors?|et al\.?|initials?|full names?)\b.{0,120}\b(?:truncated|incomplete|malformed|misparsed|drops?|omits?)\b/s.test(lower);
	const hardOriginalMismatch =
		/\b(?:reference|citation)\b.{0,80}\b(?:wrong|incorrect|different|does not match)\b.{0,80}\b(?:doi|year|venue|journal|conference|title|paper|publication)\b/s.test(lower) ||
		/\b(?:doi|year|venue|journal|conference|title)\s+(?:mismatch|does not match|is wrong|is incorrect)\b/.test(lower) ||
		/\bdifferent\s+(?:paper|publication|work|article)\b/.test(lower);
	const explicitlyExtracted = /\bextracted\s+(?:citation|reference|fields?|metadata)\b/.test(lower);
	return supportsSameWork && extractionArtifact && (!hardOriginalMismatch || explicitlyExtracted);
}

function parseVerdict(text: string): Verdict | undefined {
	const match = /^\s*(?:[-*]\s*)?verdict\s*:\s*([a-z-]+)/im.exec(text);
	const value = match?.[1]?.toLowerCase() as Verdict | undefined;
	return value && ALLOWED.includes(value) ? value : undefined;
}

function parseConfidence(text: string): number | undefined {
	const match = /^\s*(?:[-*]\s*)?confidence\s*:\s*([01](?:\.\d+)?|\d{1,3}%)/im.exec(text);
	if (!match) return undefined;
	const raw = match[1]!;
	const value = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
	if (!Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(1, value));
}

function parseReason(text: string): string | undefined {
	const match = /^\s*(?:[-*]\s*)?reason\s*:\s*(.+)$/im.exec(text);
	return match?.[1]?.trim();
}

function extractUrls(text: string): string[] {
	const urls = text.match(/https?:\/\/[^\s)\]>"']+/g) ?? [];
	return unique(urls.map((url) => url.replace(/[.,;:]+$/g, "")));
}

function summarizeReason(text: string, raw: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => !/^https?:\/\//.test(line));
	const first = lines.find((line) => !/^[-*]?\s*(verdict|confidence|evidence urls?)\s*:/i.test(line));
	return first?.slice(0, 500) ?? `Search returned output but no clear verdict for: ${raw.slice(0, 160)}`;
}

function defaultConfidence(verdict: Verdict): number {
	switch (verdict) {
		case "valid":
			return 0.9;
		case "likely-valid":
			return 0.75;
		case "mismatch":
			return 0.78;
		case "likely-hallucinated":
			return 0.82;
		case "unverified":
			return 0.55;
		case "needs-manual-review":
			return 0.4;
	}
}
