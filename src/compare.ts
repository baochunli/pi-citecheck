import type { ConversionArtifact, ConversionComparison } from "./types.ts";
import { tokenJaccard } from "./references.ts";

export function compareConversions(artifacts: ConversionArtifact[]): ConversionComparison | undefined {
	if (artifacts.length === 0) return undefined;
	const standard = artifacts.find((artifact) => artifact.mode === "standard");
	const vlm = artifacts.find((artifact) => artifact.mode === "vlm");
	const primary = choosePrimary(artifacts);
	const other = primary.mode === "standard" ? vlm : standard;
	const notesByPrimaryIndex: Record<number, string[]> = {};
	const summary: string[] = [];

	if (standard && vlm) {
		if (standard.references.length !== vlm.references.length) {
			summary.push(
				`Reference count differs between conversion modes: standard=${standard.references.length}, vlm=${vlm.references.length}.`,
			);
		}
		if (!standard.section.found) summary.push("Standard conversion did not find an explicit references heading.");
		if (!vlm.section.found) summary.push("VLM conversion did not find an explicit references heading.");
	}

	if (other) {
		for (const reference of primary.references) {
			let best = 0;
			for (const candidate of other.references) {
				best = Math.max(best, tokenJaccard(reference.raw, candidate.raw));
			}
			const notes: string[] = [];
			if (best < 0.55) {
				notes.push(`No close match in ${other.mode} conversion (best token overlap ${best.toFixed(2)}).`);
			} else if (best < 0.8) {
				notes.push(`Partial match in ${other.mode} conversion (token overlap ${best.toFixed(2)}); inspect extraction quality.`);
			}
			if (notes.length > 0) notesByPrimaryIndex[reference.index] = notes;
		}
	} else {
		summary.push("Only one conversion artifact is available; no cross-conversion comparison was possible.");
	}

	return {
		primaryMode: primary.mode,
		primaryReason: primary.mode === "standard"
			? "Using standard Docling output as primary because bibliography text is usually less distorted than VLM output."
			: "Using VLM Docling output as primary because standard output had no references or was not requested.",
		notesByPrimaryIndex,
		summary,
	};
}

export function choosePrimary(artifacts: ConversionArtifact[]): ConversionArtifact {
	const standard = artifacts.find((artifact) => artifact.mode === "standard");
	if (standard && standard.references.length > 0) return standard;
	const withRefs = artifacts.find((artifact) => artifact.references.length > 0);
	return withRefs ?? artifacts[0]!;
}
