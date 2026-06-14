# pi-citecheck

`pi-citecheck` is a standalone Pi extension that adds a `/citecheck` slash command for checking academic PDFs for likely AI-hallucinated references. It converts PDFs to Markdown with Docling, extracts only the references section, and verifies each bibliography entry using the installed `native-web-search` skill, which runs GPT Web Search.

The goal is to quickly identify references that deserve manual review: nonexistent titles, DOI mismatches, wrong venues, wrong years, or suspicious references that only appear in the paper being checked.

## Installing the Extension

```bash
pi install https://github.com/baochunli/pi-citecheck
```

After installing, start Pi and use `/citecheck` from the Pi prompt.

## Features

- Adds a Pi slash command: `/citecheck`.
- Accepts one PDF, one Markdown file, or a folder of PDFs/Markdown files.
- Defaults to **dual Docling conversion**:
  - VLM conversion using `granite_docling` with formula enrichment.
  - Standard Docling PDF conversion.
- Best-effort references-only conversion:
  - Uses `pdftotext` to find the first references page.
  - Attempts to create a smaller references-only PDF with `qpdf` or Python `pypdf`/`PyPDF2`.
  - Falls back to full-PDF conversion when automatically detected references-page slicing is unavailable.
- Supports `--refs-page <n>` / `--references-page <n>` when the page that contains references is known; this skips page detection and converts only that PDF page. If the page-only PDF cannot be created, `/citecheck` stops before Docling instead of converting the full PDF.
- Always extracts only the references/bibliography section before checking citations.
- Splits references into individual entries with numbered and author-year heuristics.
- Normalizes useful citation fields such as title, authors, year, DOI, URL, and arXiv ID.
- Runs one GPT Web Search check per reference through the existing `native-web-search` skill.
- Produces Markdown and JSON reports, including raw search outputs for auditability.
- Flags disagreement between VLM and standard Docling conversions.
- Emits visible Pi progress messages at phase changes, after reference-search milestones, after each paper, and periodically during long Docling/search steps.
- Supports `/citecheck stop` to cancel the active run and terminate launched Docling/search/helper process trees, including descendants left behind by wrappers.
- Emits `/citecheck` progress as persistent transcript messages rather than only transient status lines.

## Requirements

### Required

- [Pi](https://pi.dev/) with extension support.
- Node.js, available as `node`.
- The `native-web-search` skill installed and active in Pi.
- Docling CLI, available as `docling`.

You can verify the main executables with:

```bash
node --version
docling --help
```

### Recommended optional tools

These are not strictly required, but improve references-only PDF extraction:

- `pdftotext` from Poppler: used to identify the page where references begin.
- `qpdf`: preferred tool for slicing the PDF to the specified references page or from the detected references page to the end.
- Python package `pypdf` or `PyPDF2`: fallback PDF slicing method when `qpdf` is unavailable.

On macOS, for example:

```bash
brew install poppler qpdf
```

If `pdftotext` or PDF slicing is unavailable, `/citecheck` still works. It converts the whole PDF, then discards everything except the extracted references section before web search.

## Quick start

Check one PDF:

```text
/citecheck paper.pdf
```

Check every PDF in a folder:

```text
/citecheck ./papers --recursive
```

Write reports to a specific directory:

```text
/citecheck paper.pdf --out ./citecheck-report
```

When `--out` points at an existing output directory, papers that already have a per-paper Markdown report in `reports/` are skipped. This lets you rerun the same command to resume a stopped batch.

Check an existing Markdown conversion instead of running Docling:

```text
/citecheck converted.md --from-md
```

Limit search calls during testing:

```text
/citecheck paper.pdf --max-refs 5 --yes
```

Use only a known references page for every PDF in a run:

```text
/citecheck ./papers --recursive --refs-page 10 --yes
```

Stop a running check and terminate launched Docling/search/helper process trees:

```text
/citecheck stop
```

## Command reference

```text
/citecheck <pdf-file-or-folder> [options]
/citecheck stop
```

Subcommands:

```text
stop                        Stop the active /citecheck run and terminate launched process trees.
```

Options:

```text
--recursive                 Recurse into folders when discovering PDFs/Markdown.
--out <dir>                 Output directory. Default: .pi/citecheck/<timestamp>/; existing per-paper reports are skipped.
--conversion <mode>         dual | vlm | standard. Default: dual.
--from-md                   Treat input as Markdown and skip Docling.
--refs-page <n>             For PDFs, extract exactly page n (1-based) as the references page.
--references-page <n>       Alias for --refs-page.
--max-concurrency <n>       Concurrent web-search checks. Default: 2.
--max-refs <n>              Check only the first n references.
--yes, -y                   Skip confirmation before many web-search calls.
--help, -h                  Show usage.
```

Two additional internal/testing options are accepted:

```text
--search-timeout-ms <n>     Timeout for each native-web-search call.
--docling-timeout-ms <n>    Timeout for each Docling conversion.
```

## Default pipeline

By default, `/citecheck` uses `--conversion dual`.

For each PDF:

1. Discover the input PDF.
2. If `--refs-page` is set, create a page-only PDF for that page; otherwise try to locate the references start page with `pdftotext`.
3. If possible, create a smaller PDF covering either the specified page only or the detected references page through the end of the document.
4. Convert the PDF with Docling VLM mode.
5. Convert the PDF with Docling standard mode.
6. Extract only the references section from each Markdown output.
7. Split references into entries.
8. Prefer the standard conversion as the primary bibliography text when it produced entries.
9. Compare primary references against the other conversion and record conversion-disagreement notes.
10. Normalize each primary reference.
11. Run GPT Web Search through `native-web-search` for each reference.
12. Classify each reference and write reports.

During long-running steps, `/citecheck` also posts concise progress messages in Pi. It reports phase changes immediately and emits a heartbeat about every 30 seconds while Docling or web-search work is still running. Search progress is also reported after the first checked reference, every five references, and at completion.

## Docling conversion commands

The VLM pass follows the requested Docling flow:

```bash
docling \
  --to md \
  --output <workdir> \
  --image-export-mode placeholder \
  --enrich-formula \
  --pipeline vlm \
  --vlm-model granite_docling \
  file.pdf
```

The standard pass is:

```bash
docling \
  --to md \
  --output <workdir> \
  --image-export-mode placeholder \
  --pipeline standard \
  file.pdf
```

`--image-export-mode placeholder` is used because images are unnecessary for bibliography checking and embedded images can make Markdown outputs very large.

## Why dual mode is the default

Reference checking depends on faithful bibliography text. VLM conversion can recover difficult layouts, but it may also rewrite or distort text. Standard conversion can be more literal for searchable text PDFs, but may struggle with scanned or unusual layouts.

Dual mode gives the checker two independent views of the references section. The report records cases where a reference from the primary conversion has no close match in the other conversion, or only a partial match. These notes are useful because a suspicious citation may actually be a conversion artifact.

## References-only behavior

The extension has two references-only safeguards.

### 1. References-only checking

This is guaranteed. After Docling conversion, `/citecheck` extracts only a section headed by one of:

- `References`
- `Bibliography`
- `Works Cited`
- `Literature Cited`

The full paper body is not sent to GPT Web Search. If no explicit heading is found, the extractor uses a conservative tail-section fallback and records a warning.

### 2. References-only conversion

This is best effort. Before Docling, `/citecheck` can reduce the PDF that Docling sees:

- If `--refs-page <n>` is provided, it skips `pdftotext` detection and attempts to create a page-only PDF containing page `n`.
- Otherwise it tries to find the first page containing a references heading with `pdftotext`; if found, it attempts to create a smaller PDF from that page to the end.

PDF slicing uses:

1. `qpdf`, or
2. Python `pypdf`/`PyPDF2` fallback.

If slicing an automatically detected references start page fails, the full PDF is converted, but only the extracted references section is processed afterward. If `--refs-page` was specified and that single-page slice cannot be created, the paper is reported as an error and Docling is not run on the full PDF.

## How GPT Web Search is invoked

The extension locates the installed `native-web-search` skill and runs its `search.mjs` script with Node:

```bash
node <native-web-search>/search.mjs "<query>" \
  --purpose "<verification instructions>" \
  --provider openai-codex \
  --json
```

For each reference, the search purpose asks GPT Web Search to verify title, authors, year, venue, DOI, URL, and arXiv ID when available. It also asks for a compact structured result:

```text
Verdict: one of valid | likely-valid | mismatch | unverified | likely-hallucinated | needs-manual-review
Confidence: number from 0 to 1
Reason: one concise sentence
Evidence URLs: full URLs separated by spaces
```

Raw search outputs are saved so verdicts can be audited.

## Verdicts

Each reference receives one verdict:

| Verdict | Meaning |
|---|---|
| `valid` | Strong evidence that the reference exists and core fields match. |
| `likely-valid` | Evidence suggests the reference is real, but not all fields were confirmed. |
| `mismatch` | A found source disagrees with important fields such as title, authors, DOI, year, or venue. |
| `unverified` | Search did not find enough reliable evidence either way. |
| `likely-hallucinated` | Strong negative evidence suggests the reference is fabricated or points to a different work. |
| `needs-manual-review` | The search failed, returned unclear evidence, or the result should be inspected by a human. |

The extension is intentionally conservative. A missing search result is not automatically treated as hallucination. Stronger negative labels are reserved for mismatches or evidence that a cited work likely does not exist.

## Output layout

By default, output is written relative to the current Pi working directory:

```text
.pi/citecheck/<timestamp>/
  summary.md
  markdown/
    <paper>.vlm.md
    <paper>.standard.md
  markdown-work/
    <paper>/
      vlm/
      standard/
  refs/
    <paper>.vlm.refs.md
    <paper>.standard.refs.md
  refs-pdf/
    <paper>.refs-only.pdf
  raw-search/
    <paper>/
      ref-001.stdout.txt
      ref-002.stdout.txt
  reports/
    <paper>.report.md
```

Some files appear only when relevant. For example, `refs-pdf/` appears only if references-only PDF extraction succeeds.

## Report contents

### `summary.md`

The summary report includes:

- Start and finish timestamps.
- Output directory.
- A "Papers that need attention" table listing only papers with `mismatch` or `needs-manual-review` counts above zero.
- A "Citation checks on all papers" verdict-count table with total references, `valid`, `likely-valid`, `mismatch`, and `needs-manual-review` counts.

### Per-paper reports

Each per-paper report includes:

- Input path and conversion mode.
- References-only PDF details, if available.
- Warnings and errors.
- Conversion artifacts and references-section paths.
- Conversion comparison notes.
- A compact verdict table.
- Full details for each reference:
  - original reference text,
  - extracted fields,
  - search query,
  - verdict,
  - confidence,
  - reason,
  - evidence URLs,
  - raw search output paths.

## Repository layout

```text
pi-citecheck/
  package.json
  README.md
  tsconfig.json
  extensions/
    citecheck/
      index.ts          # Pi extension entrypoint; registers /citecheck
  src/
    args.ts             # Slash-command argument parsing
    compare.ts          # Dual-conversion comparison
    convert.ts          # Docling and refs-only PDF handling
    discover.ts         # Input discovery
    normalize.ts        # Citation metadata extraction heuristics
    references.ts       # References-section extraction and splitting
    report.ts           # Markdown report generation
    runner.ts           # End-to-end orchestration
    types.ts            # Shared types
    utils.ts            # Filesystem and formatting helpers
    verdict.ts          # Search-output classification
    web-search.ts       # native-web-search integration
  tests/
    fixtures/
      sample.md
    references.test.ts
    runner.test.ts
```

## Development

Install development dependencies:

```bash
cd ~/Playground/citecheck
npm install
```

Run tests:

```bash
npm test
```

Run the TypeScript type checker:

```bash
npm run typecheck
```

Load the extension in Pi from the local checkout:

```bash
pi -e ~/Playground/citecheck
```

## Troubleshooting

### `/citecheck` is not available

Make sure the package is loaded:

```bash
pi -e ~/Playground/citecheck
```

or installed:

```bash
pi install ~/Playground/citecheck
```

Then restart Pi or reload extensions if needed.

### `docling command not found`

Install Docling and verify:

```bash
docling --help
```

### `Could not locate native-web-search/search.mjs`

Make sure the `native-web-search` skill is installed and visible to Pi. The extension tries Pi command metadata first and then common local skill paths.

### References-only PDF extraction did not happen

This is not fatal. Install optional tools for better behavior:

```bash
brew install poppler qpdf
```

or install a Python PDF library:

```bash
python3 -m pip install pypdf
```

If these are unavailable during automatic references-page detection, `/citecheck` converts the full PDF and still extracts only the references section after conversion. If you explicitly set `--refs-page`, install `qpdf` or Python `pypdf`/`PyPDF2`; otherwise `/citecheck` refuses to run Docling on the full PDF.

### Too many search calls

Use `--max-refs` during testing:

```text
/citecheck paper.pdf --max-refs 5 --yes
```

Use `--max-concurrency 1` to make searches sequential:

```text
/citecheck paper.pdf --max-concurrency 1
```

## Limitations

- Citation parsing is heuristic and may struggle with unusual bibliography styles.
- PDF conversion can introduce errors, especially for scanned, multi-column, or heavily formatted PDFs.
- GPT Web Search can miss obscure, newly published, paywalled, non-English, or incorrectly indexed works.
- A verdict is evidence for review, not a proof.
- The extension currently performs one web-search request per reference, which can be slow or rate-limited for large bibliographies.

## Git hygiene

Generated reports under `.pi/citecheck/` are ignored by this repository.
