import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCitecheck } from "../src/runner.ts";
import type { ExecFn } from "../src/types.ts";

describe("runner", () => {
	it("checks an existing Markdown file and writes reports", async () => {
		const temp = await mkdtemp(join(tmpdir(), "citecheck-test-"));
		const skillDir = join(temp, "native-web-search");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: native-web-search\ndescription: test\n---\n", "utf8");
		await writeFile(join(skillDir, "search.mjs"), "// fake\n", "utf8");

		const progressMessages: string[] = [];
		const exec: ExecFn = async (command) => {
			if (command === "sh") return { stdout: "", stderr: "", code: 0 };
			if (command === "node") {
				return {
					stdout: JSON.stringify({
						result:
							"Verdict: likely-valid\nConfidence: 0.81\nReason: title and year match a real paper.\nEvidence URLs: https://example.com/paper",
					}),
					stderr: "",
					code: 0,
				};
			}
			return { stdout: "", stderr: `unexpected command ${command}`, code: 1 };
		};

		const fixture = join(import.meta.dirname, "fixtures", "sample.md");
		await runCitecheck(`${fixture} --from-md --out ${join(temp, "out")} --max-refs 1 --yes`, {
			cwd: temp,
			exec,
			hasUI: false,
			progress: (message) => progressMessages.push(message),
			getCommands: () => [
				{
					name: "native-web-search",
					source: "skill",
					sourceInfo: { path: join(skillDir, "SKILL.md") },
				},
			],
		});

		const summary = JSON.parse(await readFile(join(temp, "out", "summary.json"), "utf8"));
		assert.equal(summary.counts.total, 1);
		assert.equal(summary.counts["likely-valid"], 1);

		const summaryMarkdown = await readFile(join(temp, "out", "summary.md"), "utf8");
		assert.doesNotMatch(summaryMarkdown, /## Verdict counts/);
		assert.match(summaryMarkdown, /## Paper attention counts/);
		assert.match(summaryMarkdown, /\| Paper \| mismatch \| needs-manual-review \|/);
		assert.match(summaryMarkdown, /\| sample\.md \| 0 \| 0 \|/);
		assert.match(summaryMarkdown, /## Per-paper verdict counts/);
		assert.match(summaryMarkdown, /\| Paper \| Total references \| valid \| likely-valid \| mismatch \| needs-manual-review \|/);
		assert.match(summaryMarkdown, /\| sample\.md \| 1 \| 0 \| 1 \| 0 \| 0 \|/);
		assert.ok(progressMessages.some((message) => message.includes("/citecheck processing 1 Markdown file")));
		assert.ok(progressMessages.some((message) => message.includes("/citecheck web-search started: sample")));
		assert.ok(progressMessages.some((message) => message.includes("/citecheck web-search 1/1: sample")));
		assert.ok(progressMessages.some((message) => message.includes("/citecheck complete:")));

		const paper = JSON.parse(await readFile(join(temp, "out", "reports", "sample.report.json"), "utf8"));
		assert.equal(paper.checks.length, 1);
		assert.equal(paper.checks[0].verdict, "likely-valid");
		assert.match(paper.artifacts[0].section.markdown, /ImageNet Classification/);
	});

	it("uses a specified references page as a single-page PDF slice", async () => {
		const temp = await mkdtemp(join(tmpdir(), "citecheck-test-"));
		const skillDir = join(temp, "native-web-search");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: native-web-search\ndescription: test\n---\n", "utf8");
		await writeFile(join(skillDir, "search.mjs"), "// fake\n", "utf8");

		const pdf = join(temp, "paper.pdf");
		await writeFile(pdf, "%PDF fake\n", "utf8");

		const calls: Array<{ command: string; args: string[] }> = [];
		const exec: ExecFn = async (command, args) => {
			calls.push({ command, args });
			if (command === "sh") return { stdout: "", stderr: "", code: 0 };
			if (command === "qpdf") return { stdout: "", stderr: "", code: 0 };
			if (command === "docling") {
				const outIndex = args.indexOf("--output");
				assert.notEqual(outIndex, -1);
				const outDir = args[outIndex + 1]!;
				await mkdir(outDir, { recursive: true });
				await writeFile(
					join(outDir, "converted.md"),
					"# Converted\n\n## References\n\n[1] A. Author, 'Known Paper,' Journal, 2020.\n",
					"utf8",
				);
				return { stdout: "", stderr: "", code: 0 };
			}
			if (command === "node") {
				return {
					stdout: JSON.stringify({
						result:
							"Verdict: valid\nConfidence: 0.90\nReason: title and year match a real paper.\nEvidence URLs: https://example.com/paper",
					}),
					stderr: "",
					code: 0,
				};
			}
			return { stdout: "", stderr: `unexpected command ${command}`, code: 1 };
		};

		await runCitecheck(`${pdf} --refs-page 10 --conversion standard --out ${join(temp, "out")} --yes`, {
			cwd: temp,
			exec,
			hasUI: false,
			getCommands: () => [
				{
					name: "native-web-search",
					source: "skill",
					sourceInfo: { path: join(skillDir, "SKILL.md") },
				},
			],
		});

		assert.equal(calls.some((call) => call.command === "pdftotext"), false);
		const qpdf = calls.find((call) => call.command === "qpdf");
		assert.ok(qpdf);
		assert.deepEqual(qpdf.args.slice(0, 5), ["--empty", "--pages", pdf, "10", "--"]);

		const docling = calls.find((call) => call.command === "docling");
		assert.equal(docling?.args.at(-1), qpdf.args[5]);
		assert.equal(docling?.args.includes(pdf), false);

		const paper = JSON.parse(await readFile(join(temp, "out", "reports", "paper.report.json"), "utf8"));
		assert.equal(paper.refsOnlyPdf.startPage, 10);
		assert.equal(paper.refsOnlyPdf.endPage, 10);
		assert.equal(paper.refsOnlyPdf.source, "specified");
		assert.equal(paper.refsOnlyPdf.method, "qpdf");
		assert.equal(paper.checks[0].verdict, "valid");
	});

	it("does not fall back to full-PDF Docling when a specified references page cannot be sliced", async () => {
		const temp = await mkdtemp(join(tmpdir(), "citecheck-test-"));
		const skillDir = join(temp, "native-web-search");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: native-web-search\ndescription: test\n---\n", "utf8");
		await writeFile(join(skillDir, "search.mjs"), "// fake\n", "utf8");

		const pdf = join(temp, "paper.pdf");
		await writeFile(pdf, "%PDF fake\n", "utf8");

		const calls: Array<{ command: string; args: string[] }> = [];
		const exec: ExecFn = async (command, args) => {
			calls.push({ command, args });
			if (command === "sh") {
				const script = args[1] ?? "";
				if (script.includes("qpdf") || script.includes("python3")) {
					return { stdout: "", stderr: "", code: 1 };
				}
				return { stdout: "", stderr: "", code: 0 };
			}
			return { stdout: "", stderr: `unexpected command ${command}`, code: 1 };
		};

		await runCitecheck(`${pdf} --refs-page 10 --conversion standard --out ${join(temp, "out")} --yes`, {
			cwd: temp,
			exec,
			hasUI: false,
			getCommands: () => [
				{
					name: "native-web-search",
					source: "skill",
					sourceInfo: { path: join(skillDir, "SKILL.md") },
				},
			],
		});

		assert.equal(calls.some((call) => call.command === "docling"), false);
		const paper = JSON.parse(await readFile(join(temp, "out", "reports", "paper.report.json"), "utf8"));
		assert.equal(paper.artifacts.length, 0);
		assert.match(paper.errors[0], /refusing to convert the full PDF/);
	});
});
