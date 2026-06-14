import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { ExecFn } from "./types.ts";

export function timestampForPath(date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

export function slugifyPath(file: string): string {
	const name = basename(file, extname(file));
	const slug = name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 96);
	return slug || "document";
}

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

export async function writeText(path: string, text: string): Promise<void> {
	await ensureDir(dirname(path));
	await writeFile(path, text, "utf8");
}

export async function commandExists(exec: ExecFn, command: string): Promise<boolean> {
	const result = await exec("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`]);
	return result.code === 0;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function findMarkdownFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	await walkFiles(dir, async (file) => {
		if (extname(file).toLowerCase() === ".md") files.push(file);
	});
	files.sort();
	return files;
}

export async function newestFile(files: string[]): Promise<string | undefined> {
	let newest: { file: string; mtime: number } | undefined;
	for (const file of files) {
		const info = await stat(file).catch(() => undefined);
		if (!info) continue;
		if (!newest || info.mtimeMs > newest.mtime) newest = { file, mtime: info.mtimeMs };
	}
	return newest?.file;
}

async function walkFiles(dir: string, onFile: (file: string) => Promise<void>): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) await walkFiles(full, onFile);
		else if (entry.isFile()) await onFile(full);
	}
}

export function firstLine(text: string, max = 180): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

export function truncateForReport(text: string, max = 4000): string {
	return text.length <= max ? text : text.slice(0, max) + `\n\n[truncated ${text.length - max} chars]`;
}

export function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}
