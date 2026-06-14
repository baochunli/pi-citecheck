import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractReferenceSection, splitReferences, tokenJaccard } from "../src/references.ts";
import { normalizeReference } from "../src/normalize.ts";
import { parseCitecheckArgs, tokenize, USAGE } from "../src/args.ts";
import { classifyEvidence } from "../src/verdict.ts";

describe("argument parsing", () => {
	it("defaults to dual conversion", () => {
		const parsed = parseCitecheckArgs("paper.pdf");
		assert.equal(parsed.ok, true);
		assert.equal(parsed.options?.conversion, "dual");
	});

	it("parses a known references page", () => {
		const parsed = parseCitecheckArgs("paper.pdf --refs-page 10");
		assert.equal(parsed.ok, true);
		assert.equal(parsed.options?.refsPage, 10);
	});

	it("documents command controls in help", () => {
		assert.match(USAGE, /stop\s+Stop the active \/citecheck run and terminate launched process trees\./);
		assert.match(USAGE, /--refs-page <n>\s+For PDFs, extract exactly page n \(1-based\) as the references page\./);
		assert.match(USAGE, /--references-page <n>\s+Alias for --refs-page\./);
	});

	it("tokenizes quoted paths", () => {
		assert.deepEqual(tokenize('"my paper.pdf" --out "reports here"'), ["my paper.pdf", "--out", "reports here"]);
	});
});

describe("reference extraction", () => {
	it("extracts only the references section", async () => {
		const md = await readFile(join(import.meta.dirname, "fixtures", "sample.md"), "utf8");
		const section = extractReferenceSection(md);
		assert.equal(section.found, true);
		assert.match(section.markdown, /ImageNet Classification/);
		assert.doesNotMatch(section.markdown, /Not references/);
	});

	it("splits numbered references", async () => {
		const md = await readFile(join(import.meta.dirname, "fixtures", "sample.md"), "utf8");
		const refs = splitReferences(extractReferenceSection(md).markdown);
		assert.equal(refs.length, 3);
		assert.match(refs[0]!.raw, /ImageNet Classification/);
		assert.match(refs[1]!.raw, /Deep residual learning/i);
	});

	it("normalizes useful search fields", async () => {
		const md = await readFile(join(import.meta.dirname, "fixtures", "sample.md"), "utf8");
		const ref = splitReferences(extractReferenceSection(md).markdown)[0]!;
		const normalized = normalizeReference(ref);
		assert.equal(normalized.year, "2012");
		assert.equal(normalized.title, "ImageNet Classification with Deep Convolutional Neural Networks");
		assert.match(normalized.query, /ImageNet Classification/);
	});

	it("extracts single-quoted titles without absorbing et al author text", () => {
		const ref = {
			index: 13,
			raw: "[13] Z. Li, S. Le, J. Chen, et al., 'Decomposed and Distributed Modulation to Achieve Secure Transmission,' IEEE Trans. Mobile Comput., vol. 23, no. 12, pp. 11172-11190, 2024.",
		};
		const normalized = normalizeReference(ref);
		assert.equal(normalized.title, "Decomposed and Distributed Modulation to Achieve Secure Transmission");
		assert.equal(normalized.authors, "Z. Li, S. Le, J. Chen, et al");
		assert.equal(
			normalized.query,
			'"Decomposed and Distributed Modulation to Achieve Secure Transmission" Z. Li 2024',
		);
	});

	it("does not treat extraction-artifact mismatch evidence as a citation mismatch", () => {
		const ref = {
			index: 17,
			raw: "[17] Z. Li, C. Liu, L. Zhang, et al., 'Exploiting Interference With an Intelligent Reflecting Surface to Enhance Data Transmission,' IEEE Trans. Wireless Commun., vol. 23, no. 8, pp. 9776-9792, 2024.",
		};
		const result = classifyEvidence(ref, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: mismatch\nConfidence: 0.98\nReason: The cited paper is real, but the extracted reference misstates the title/venue details and truncates the author list; the authentic record is 2024 in IEEE Transactions on Wireless Communications with DOI 10.1109/TWC.2024.3366229.\nEvidence URLs: https://doi.org/10.1109/TWC.2024.3366229",
		});
		assert.equal(result.verdict, "likely-valid");
		assert.match(result.reason, /extraction or abbreviation artifact/);
	});

	it("keeps material original-reference mismatches as mismatches", () => {
		const result = classifyEvidence({ index: 7, raw: "[7] A. Author, 'Real Paper,' Journal, 2016." }, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: mismatch\nConfidence: 0.91\nReason: The cited paper is real, but the reference has a year mismatch: the original reference lists 2016 while the canonical record shows 2017.\nEvidence URLs: https://doi.org/10.0000/example",
		});
		assert.equal(result.verdict, "mismatch");
	});

	it("computes fuzzy overlap for conversion comparison", () => {
		const a = "[1] A. Author, Interesting Systems Paper, IEEE INFOCOM, 2024.";
		const b = "1. A. Author. Interesting Systems Paper. Proc. IEEE INFOCOM, 2024.";
		assert.ok(tokenJaccard(a, b) > 0.55);
	});
});
