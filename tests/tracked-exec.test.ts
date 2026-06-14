import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTrackedExec } from "../src/tracked-exec.ts";

describe("tracked exec", () => {
	it("kills launched child process trees on abort", { skip: process.platform === "win32" }, async () => {
		const temp = await mkdtemp(join(tmpdir(), "citecheck-tracked-exec-"));
		const tracked = createTrackedExec(temp);
		const controller = new AbortController();
		let childPid: number | undefined;

		const running = tracked.exec(
			"sh",
			["-lc", `node -e "setInterval(() => {}, 1000)" & echo $! > child.pid; wait`],
			{ signal: controller.signal, timeout: 30_000 },
		);

		try {
			childPid = await waitForPid(join(temp, "child.pid"));
			assert.equal(isProcessAlive(childPid), true);
			assert.equal(tracked.activeCount(), 1);

			controller.abort();
			tracked.killAll();

			const result = await running;
			assert.equal(result.killed, true);
			await waitUntil(() => !isProcessAlive(childPid!), 7_000);
			assert.equal(tracked.activeCount(), 0);
		} finally {
			if (childPid && isProcessAlive(childPid)) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
	});

	it("kills background descendants even after the wrapper process exits", { skip: process.platform === "win32" }, async () => {
		const temp = await mkdtemp(join(tmpdir(), "citecheck-tracked-exec-"));
		const tracked = createTrackedExec(temp);
		let childPid: number | undefined;

		await tracked.exec(
			"sh",
			["-lc", `node -e "setInterval(() => {}, 1000)" >/dev/null 2>&1 < /dev/null & echo $! > child.pid`],
			{ timeout: 30_000 },
		);

		try {
			childPid = await waitForPid(join(temp, "child.pid"));
			assert.equal(isProcessAlive(childPid), true);
			assert.equal(tracked.activeCount(), 0);

			tracked.killAll();

			await waitUntil(() => !isProcessAlive(childPid!), 7_000);
		} finally {
			if (childPid && isProcessAlive(childPid)) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
	});
});

async function waitForPid(path: string): Promise<number> {
	let lastError: unknown;
	const startedAt = Date.now();
	while (Date.now() - startedAt < 5_000) {
		try {
			const text = await readFile(path, "utf8");
			const pid = Number(text.trim());
			if (Number.isInteger(pid) && pid > 0) return pid;
		} catch (error) {
			lastError = error;
		}
		await delay(25);
	}
	throw new Error(`Timed out waiting for child pid: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (predicate()) return;
		await delay(50);
	}
	assert.equal(predicate(), true);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
