import { readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { DiscoveredInput } from "./types.ts";

const SKIP_DIRS = new Set([".git", "node_modules", ".pi", "dist", "coverage"]);

export async function discoverInputs(cwd: string, input: string, fromMd: boolean, recursive: boolean): Promise<DiscoveredInput[]> {
	const root = resolve(cwd, expandHome(input));
	const info = await stat(root).catch((error: unknown) => {
		throw new Error(`Input path does not exist: ${root} (${String((error as Error).message ?? error)})`);
	});

	const wanted = fromMd ? ".md" : ".pdf";
	const kind: DiscoveredInput["kind"] = fromMd ? "md" : "pdf";

	if (info.isFile()) {
		if (extname(root).toLowerCase() !== wanted) {
			throw new Error(`Expected a ${wanted} file${fromMd ? " because --from-md is set" : ""}: ${root}`);
		}
		return [{ path: root, kind }];
	}

	if (!info.isDirectory()) {
		throw new Error(`Input path is neither a file nor a directory: ${root}`);
	}

	const results: DiscoveredInput[] = [];
	await walk(root, recursive, async (file) => {
		if (extname(file).toLowerCase() === wanted) {
			results.push({ path: file, kind });
		}
	});
	results.sort((a, b) => a.path.localeCompare(b.path));
	return results;
}

async function walk(dir: string, recursive: boolean, onFile: (file: string) => Promise<void>): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (recursive && !SKIP_DIRS.has(entry.name)) {
				await walk(full, recursive, onFile);
			}
			continue;
		}
		if (entry.isFile()) {
			await onFile(full);
		}
	}
}

export function expandHome(path: string): string {
	if (path === "~") return process.env.HOME ?? path;
	if (path.startsWith("~/")) return join(process.env.HOME ?? "", path.slice(2));
	return path;
}
