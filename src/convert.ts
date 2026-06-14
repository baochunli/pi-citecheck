import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { throwIfAborted } from "./cancel.ts";
import type { CitecheckOptions, ConversionArtifact, ExecFn, RefsOnlyPdfResult } from "./types.ts";
import { extractReferenceSection, splitReferences } from "./references.ts";
import { commandExists, ensureDir, findMarkdownFiles, newestFile, shellQuote, slugifyPath, writeText } from "./utils.ts";

export async function prepareRefsOnlyPdf(
	pdfPath: string,
	slug: string,
	outDir: string,
	exec: ExecFn,
	signal?: AbortSignal,
	refsPage?: number,
): Promise<RefsOnlyPdfResult> {
	throwIfAborted(signal);
	if (refsPage !== undefined) {
		return sliceReferencesPdf(pdfPath, slug, outDir, refsPage, refsPage, "specified", exec, signal);
	}

	if (!(await commandExists(exec, "pdftotext"))) {
		return { warnings: ["pdftotext not found; skipping references-page detection before Docling."] };
	}

	const temp = await mkdtemp(join(tmpdir(), "citecheck-pdftotext-"));
	const textPath = join(temp, `${slug}.txt`);
	const textResult = await exec("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, textPath], {
		signal,
		timeout: 120_000,
	});
	throwIfAborted(signal);
	if (textResult.code !== 0) {
		return { warnings: [`pdftotext failed; converting full PDF. ${textResult.stderr || textResult.stdout}`] };
	}

	const text = await readFile(textPath, "utf8").catch(() => "");
	const startPage = findReferencesStartPage(text);
	if (!startPage) {
		return { warnings: ["Could not identify a references start page with pdftotext; converting full PDF."] };
	}

	return sliceReferencesPdf(pdfPath, slug, outDir, startPage, undefined, "detected", exec, signal);
}

async function sliceReferencesPdf(
	pdfPath: string,
	slug: string,
	outDir: string,
	startPage: number,
	endPage: number | undefined,
	source: "detected" | "specified",
	exec: ExecFn,
	signal?: AbortSignal,
): Promise<RefsOnlyPdfResult> {
	const warnings: string[] = [];
	const refsPdfDir = join(outDir, "refs-pdf");
	await ensureDir(refsPdfDir);
	const refsPdf = join(refsPdfDir, `${slug}.refs-only.pdf`);

	throwIfAborted(signal);
	const qpdf = await tryQpdfSlice(pdfPath, refsPdf, startPage, endPage, exec, signal);
	throwIfAborted(signal);
	if (qpdf.ok) return { path: refsPdf, startPage, endPage, source, method: "qpdf", warnings };
	warnings.push(qpdf.warning);

	const python = await tryPythonSlice(pdfPath, refsPdf, startPage, endPage, exec, signal);
	throwIfAborted(signal);
	if (python.ok) return { path: refsPdf, startPage, endPage, source, method: python.method, warnings };
	warnings.push(python.warning);

	if (source === "specified") {
		const details = warnings.length > 0 ? ` ${warnings.join(" ")}` : "";
		throw new Error(
			`Specified --refs-page ${startPage}, but could not create a page-only PDF for Docling; refusing to convert the full PDF.${details}`,
		);
	}

	warnings.push(`Detected references start page ${startPage}, but could not create a references-only PDF; converting full PDF.`);
	return { startPage, endPage, source, warnings };
}

export async function runDoclingConversions(
	pdfPath: string,
	slug: string,
	outDir: string,
	options: CitecheckOptions,
	exec: ExecFn,
	signal?: AbortSignal,
): Promise<ConversionArtifact[]> {
	throwIfAborted(signal);
	if (!(await commandExists(exec, "docling"))) {
		throwIfAborted(signal);
		throw new Error("docling command not found. Install Docling first, then retry /citecheck.");
	}

	const modes: Array<"vlm" | "standard"> =
		options.conversion === "dual" ? ["vlm", "standard"] : [options.conversion];
	const artifacts: ConversionArtifact[] = [];

	for (const mode of modes) {
		throwIfAborted(signal);
		const workDir = join(outDir, "markdown-work", slug, mode);
		await ensureDir(workDir);
		const args = doclingArgs(pdfPath, workDir, mode);
		const result = await exec("docling", args, { signal, timeout: options.doclingTimeoutMs });
		throwIfAborted(signal);
		if (result.code !== 0) {
			throw new Error(`Docling ${mode} conversion failed for ${basename(pdfPath)}:\n${result.stderr || result.stdout}`);
		}

		const markdownFiles = await findMarkdownFiles(workDir);
		const generated = await newestFile(markdownFiles);
		if (!generated) {
			throw new Error(`Docling ${mode} conversion did not produce a Markdown file in ${workDir}.`);
		}

		const markdownCopy = join(outDir, "markdown", `${slug}.${mode}.md`);
		await ensureDir(join(outDir, "markdown"));
		await copyFile(generated, markdownCopy);
		const markdown = await readFile(markdownCopy, "utf8");
		const section = extractReferenceSection(markdown);
		const refsPath = join(outDir, "refs", `${slug}.${mode}.refs.md`);
		await writeText(refsPath, section.markdown + (section.markdown.endsWith("\n") ? "" : "\n"));
		const references = splitReferences(section.markdown);
		artifacts.push({ mode, markdownPath: markdownCopy, refsPath, section, references });
	}

	return artifacts;
}

export async function artifactFromMarkdown(mdPath: string, slug: string, outDir: string): Promise<ConversionArtifact> {
	const markdownCopy = join(outDir, "markdown", `${slug}.input.md`);
	await ensureDir(join(outDir, "markdown"));
	await copyFile(mdPath, markdownCopy);
	const markdown = await readFile(markdownCopy, "utf8");
	const section = extractReferenceSection(markdown);
	const refsPath = join(outDir, "refs", `${slug}.input.refs.md`);
	await writeText(refsPath, section.markdown + (section.markdown.endsWith("\n") ? "" : "\n"));
	return { mode: "standard", markdownPath: markdownCopy, refsPath, section, references: splitReferences(section.markdown) };
}

function doclingArgs(pdfPath: string, outDir: string, mode: "vlm" | "standard"): string[] {
	const base = ["--to", "md", "--output", outDir, "--image-export-mode", "placeholder"];
	if (mode === "vlm") {
		return [...base, "--enrich-formula", "--pipeline", "vlm", "--vlm-model", "granite_docling", pdfPath];
	}
	return [...base, "--pipeline", "standard", pdfPath];
}

function findReferencesStartPage(pdftotextOutput: string): number | undefined {
	const pages = pdftotextOutput.split("\f");
	const hits: number[] = [];
	for (let i = 0; i < pages.length; i++) {
		const lines = pages[i]!.split("\n");
		if (lines.some((line) => isPdfReferenceHeading(line))) hits.push(i + 1);
	}
	if (hits.length === 0) return undefined;
	const later = hits.filter((page) => page >= Math.max(1, Math.floor(pages.length * 0.45)));
	return later[0] ?? hits[hits.length - 1];
}

function isPdfReferenceHeading(line: string): boolean {
	const text = line
		.trim()
		.replace(/^\d+(?:\.\d+)*\s+/, "")
		.replace(/^[IVXLC]+\.?\s+/i, "")
		.replace(/[#:：]+$/g, "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ");
	return ["references", "bibliography", "works cited", "literature cited"].includes(text);
}

async function tryQpdfSlice(
	pdfPath: string,
	outPath: string,
	startPage: number,
	endPage: number | undefined,
	exec: ExecFn,
	signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; warning: string }> {
	if (!(await commandExists(exec, "qpdf"))) {
		return { ok: false, warning: "qpdf not found for references-only PDF extraction." };
	}
	const pageSpec = endPage === undefined ? `${startPage}-z` : startPage === endPage ? String(startPage) : `${startPage}-${endPage}`;
	const result = await exec("qpdf", ["--empty", "--pages", pdfPath, pageSpec, "--", outPath], {
		signal,
		timeout: 120_000,
	});
	if (result.code === 0) return { ok: true };
	return { ok: false, warning: `qpdf references-only extraction failed: ${result.stderr || result.stdout}` };
}

async function tryPythonSlice(
	pdfPath: string,
	outPath: string,
	startPage: number,
	endPage: number | undefined,
	exec: ExecFn,
	signal?: AbortSignal,
): Promise<{ ok: true; method: string } | { ok: false; warning: string }> {
	if (!(await commandExists(exec, "python3"))) {
		return { ok: false, warning: "python3 not found for pypdf/PyPDF2 fallback extraction." };
	}
	const temp = await mkdtemp(join(tmpdir(), "citecheck-pypdf-"));
	const script = join(temp, "slice_pdf.py");
	await writeFile(
		script,
		`import sys\n\nmethod = None\ntry:\n    from pypdf import PdfReader, PdfWriter\n    method = "pypdf"\nexcept Exception:\n    try:\n        from PyPDF2 import PdfReader, PdfWriter\n        method = "PyPDF2"\n    except Exception as exc:\n        print(f"missing pypdf/PyPDF2: {exc}", file=sys.stderr)\n        sys.exit(2)\n\ninput_path, output_path, start = sys.argv[1], sys.argv[2], int(sys.argv[3])\nend = int(sys.argv[4]) if len(sys.argv) > 4 else None\nreader = PdfReader(input_path)\ntotal = len(reader.pages)\nif start < 1 or start > total:\n    print(f"start page {start} is outside PDF page range 1-{total}", file=sys.stderr)\n    sys.exit(3)\nif end is not None and end < start:\n    print(f"end page {end} is before start page {start}", file=sys.stderr)\n    sys.exit(3)\nstop = total if end is None else min(end, total)\nwriter = PdfWriter()\nfor idx in range(start - 1, stop):\n    writer.add_page(reader.pages[idx])\nwith open(output_path, "wb") as f:\n    writer.write(f)\nprint(method)\n`,
		"utf8",
	);
	const args = [script, pdfPath, outPath, String(startPage)];
	if (endPage !== undefined) args.push(String(endPage));
	const result = await exec("python3", args, { signal, timeout: 120_000 });
	if (result.code === 0) {
		return { ok: true, method: result.stdout.trim() || "python-pdf" };
	}
	return { ok: false, warning: `Python PDF extraction fallback failed: ${result.stderr || result.stdout}` };
}
