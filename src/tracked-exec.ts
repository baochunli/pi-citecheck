import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { ExecFn, ExecOptions, ExecResult } from "./types.ts";

export interface TrackedExecController {
	exec: ExecFn;
	killAll: () => void;
	activeCount: () => number;
}

interface ActiveProcess {
	kill: () => void;
}

const TERMINATION_GRACE_MS = 5_000;

export function createTrackedExec(defaultCwd: string): TrackedExecController {
	const active = new Set<ActiveProcess>();
	const rootPids = new Set<number>();
	const processGroups = new Set<number>();

	const exec: ExecFn = async (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
		return new Promise<ExecResult>((resolve) => {
			let stdout = "";
			let stderr = "";
			let killed = false;
			let settled = false;
			let timeoutId: NodeJS.Timeout | undefined;
			let forceKillId: NodeJS.Timeout | undefined;

			const child = spawn(command, args, {
				cwd: options?.cwd ?? defaultCwd,
				detached: process.platform !== "win32",
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			if (child.pid) {
				rootPids.add(child.pid);
				if (process.platform !== "win32") processGroups.add(child.pid);
			}

			const kill = () => {
				if (!killed) killed = true;
				killProcessTree(child, "SIGTERM");
				if (!forceKillId) {
					forceKillId = setTimeout(() => {
						if (!settled) killProcessTree(child, "SIGKILL");
					}, TERMINATION_GRACE_MS);
					forceKillId.unref?.();
				}
			};

			const activeProcess: ActiveProcess = { kill };
			active.add(activeProcess);

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				if (forceKillId) clearTimeout(forceKillId);
				active.delete(activeProcess);
				options?.signal?.removeEventListener("abort", kill);
			};

			const finish = (result: ExecResult) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};

			if (options?.signal) {
				if (options.signal.aborted) kill();
				else options.signal.addEventListener("abort", kill, { once: true });
			}

			if (options?.timeout && options.timeout > 0) {
				timeoutId = setTimeout(kill, options.timeout);
				timeoutId.unref?.();
			}

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			child.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			child.on("error", (error) => {
				stderr += `${stderr ? "\n" : ""}${error.message}`;
				finish({ stdout, stderr, code: 1, killed });
			});
			child.on("close", (code) => {
				finish({ stdout, stderr, code: code ?? (killed ? 143 : 1), killed });
			});
		});
	};

	const killKnownProcesses = (signal: NodeJS.Signals) => {
		for (const entry of [...active]) entry.kill();
		for (const pid of [...rootPids]) killProcessTreeByPid(pid, signal, processGroups);
		for (const pgid of [...processGroups]) killProcessGroup(pgid, signal);
	};

	return {
		exec,
		killAll: () => {
			killKnownProcesses("SIGTERM");
			const forceKill = setTimeout(() => killKnownProcesses("SIGKILL"), TERMINATION_GRACE_MS);
			forceKill.unref?.();
		},
		activeCount: () => active.size,
	};
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (!pid) return;
	killProcessTreeByPid(pid, signal, process.platform !== "win32" ? new Set([pid]) : new Set());
	try {
		child.kill(signal);
	} catch {
		// Process may have already exited.
	}
}

function killProcessTreeByPid(pid: number, signal: NodeJS.Signals, processGroups: Set<number>): void {
	if (process.platform === "win32") {
		const taskkill = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
		taskkill.on("error", () => undefined);
		tryKill(pid, signal);
		return;
	}

	const descendants = collectDescendants(pid);
	for (const childPid of descendants.sort((a, b) => b - a)) {
		tryKill(childPid, signal);
	}
	killProcessGroup(pid, signal);
	for (const pgid of processGroups) killProcessGroup(pgid, signal);
	tryKill(pid, signal);
}

function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		// createTrackedExec spawns Unix children as detached process-group leaders.
		// A negative PID targets the whole process group, including grandchildren
		// launched by docling, node, shell helpers, or native-web-search. We keep
		// process group ids for the entire /citecheck run so children left behind
		// by short-lived wrappers are still terminated by /citecheck stop.
		process.kill(-pgid, signal);
	} catch {
		// Process group may have already exited.
	}
}

function tryKill(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Process may have already exited.
	}
}

function collectDescendants(rootPid: number): number[] {
	const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
	if (result.status !== 0 || !result.stdout) return [];

	const childrenByParent = new Map<number, number[]>();
	for (const line of result.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		const ppid = Number(match[2]);
		if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
		const children = childrenByParent.get(ppid) ?? [];
		children.push(pid);
		childrenByParent.set(ppid, children);
	}

	const descendants: number[] = [];
	const stack = [...(childrenByParent.get(rootPid) ?? [])];
	while (stack.length > 0) {
		const pid = stack.pop()!;
		descendants.push(pid);
		stack.push(...(childrenByParent.get(pid) ?? []));
	}
	return descendants;
}
