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
		assert.match(result.reason, /extraction, abbreviation, or punctuation artifact/);
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

	it("overrides likely-valid when evidence reports a wrong journal venue", () => {
		const result = classifyEvidence({
			index: 3,
			raw: "[3] E. Kim, I. P. Roberts, and J. G. Andrews, 'Downlink analysis and evaluation of multi-beam leo satellite communication in shadowed rician channels,' IEEE Transactions on Wireless Communications, 2023, early Access.",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: likely-valid\nConfidence: 0.97\nReason: The cited paper is real and matches the title and authors, but the reference’s venue/year are slightly off: it appears as a 2024 IEEE Transactions on Vehicular Technology article, not IEEE Transactions on Wireless Communications.\nEvidence URLs: https://dblp.org/rec/journals/tvt/KimRA24\n\nResearch summary:\nThe journal is IEEE Transactions on Vehicular Technology, which conflicts with the reference’s Wireless Communications venue. Multiple sources disagree on venue/year, not on paper identity. Treat the original citation’s IEEE Transactions on Wireless Communications, 2023, early Access as likely incorrect.",
		});
		assert.equal(result.verdict, "mismatch");
		assert.match(result.reason, /material bibliographic mismatch/);
	});

	it("does not treat initials and hyphenation variants as citation mismatches", () => {
		const result = classifyEvidence({
			index: 41,
			raw: "[41] B. Wang, F. Zhu, W. Li, Z. Yang, M. Jin, and X. Tian, 'Frequencyagile ofdm backscatter,' in Proceedings of the 22nd Annual International Conference on Mobile Systems, Applications and Services, p. 252-264, ACM New York, NY, USA, 2024.",
		}, {
			query: "",
			purpose: "",
			resultText:
				"Verdict: mismatch\nConfidence: 0.97\nReason: The cited work is real, but the original reference’s author list is wrong and the venue/title details are partly mismatched with the actual MobiSys 2024 paper.\nEvidence URLs: https://doi.org/10.1145/3643832.3661873\n\nTitle: Frequency-agile OFDM Backscatter is the real paper title. Authors: Bingbing Wang, Fengyuan Zhu, Wenhui Li, Zeming Yang, Meng Jin, Xiaohua Tian; this differs from initials, which is acceptable. Venue matches the Proceedings of the 22nd Annual International Conference on Mobile Systems, Applications and Services. Pages 252–264 align, and the DOI resolves to the paper. This is not a title/venue mismatch.",
		});
		assert.equal(result.verdict, "likely-valid");
	});

	it("computes fuzzy overlap for conversion comparison", () => {
		const a = "[1] A. Author, Interesting Systems Paper, IEEE INFOCOM, 2024.";
		const b = "1. A. Author. Interesting Systems Paper. Proc. IEEE INFOCOM, 2024.";
		assert.ok(tokenJaccard(a, b) > 0.55);
	});
});
