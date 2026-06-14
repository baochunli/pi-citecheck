import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CitecheckAbortError, isCitecheckAbort } from "../../src/cancel.ts";
import { parseCitecheckArgs, USAGE } from "../../src/args.ts";
import { runCitecheck } from "../../src/runner.ts";
import { createTrackedExec, type TrackedExecController } from "../../src/tracked-exec.ts";

interface ActiveRun {
	controller: AbortController;
	exec: TrackedExecController;
	startedAt: number;
}

const MESSAGE_TYPE = "citecheck-progress";

export default function citecheckExtension(pi: ExtensionAPI) {
	let activeRun: ActiveRun | undefined;

	function postMessage(message: string, level: "info" | "warning" | "error" = "info"): void {
		pi.sendMessage({
			customType: MESSAGE_TYPE,
			content: message,
			display: true,
			details: { level, timestamp: Date.now() },
		});
	}

	function stopActiveRun(reason = "Stopped by /citecheck stop."): number {
		if (!activeRun) return 0;
		const activeProcesses = activeRun.exec.activeCount();
		if (!activeRun.controller.signal.aborted) {
			activeRun.controller.abort(new CitecheckAbortError(reason));
		}
		activeRun.exec.killAll();
		return activeProcesses;
	}

	pi.on("session_shutdown", async () => {
		stopActiveRun("/citecheck stopped because the Pi session is shutting down.");
	});

	pi.registerCommand("citecheck", {
		description: "Check PDFs for likely hallucinated references using Docling and GPT Web Search",
		getArgumentCompletions: (prefix) => {
			const options = [
				"stop",
				"--recursive",
				"--out ",
				"--conversion dual",
				"--conversion vlm",
				"--conversion standard",
				"--from-md",
				"--refs-page ",
				"--references-page ",
				"--max-concurrency ",
				"--max-refs ",
				"--yes",
				"--help",
			];
			const last = prefix.split(/\s+/).pop() ?? "";
			const filtered = options.filter((option) => option.startsWith(last));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			if (/^stop(?:\s|$)/i.test(args.trim())) {
				if (!activeRun) {
					postMessage("No active /citecheck run to stop.", "info");
					return;
				}
				const activeProcesses = stopActiveRun();
				postMessage(
					`/citecheck stop requested; terminating ${activeProcesses} active direct process(es) plus any launched descendants.`,
					"warning",
				);
				return;
			}

			const parsed = parseCitecheckArgs(args);
			if (parsed.help) {
				postMessage(USAGE, "info");
				return;
			}
			if (!parsed.ok) {
				postMessage(parsed.error ?? "Invalid /citecheck arguments", "error");
				return;
			}

			if (activeRun) {
				const elapsedSeconds = Math.max(0, Math.floor((Date.now() - activeRun.startedAt) / 1000));
				postMessage(
					`/citecheck is already running (${elapsedSeconds}s elapsed). Use /citecheck stop first.`,
					"warning",
				);
				return;
			}

			const controller = new AbortController();
			const trackedExec = createTrackedExec(ctx.cwd);
			const run: ActiveRun = {
				controller,
				exec: trackedExec,
				startedAt: Date.now(),
			};
			activeRun = run;

			const forwardCtxAbort = () => stopActiveRun("/citecheck stopped because the current Pi operation was aborted.");
			ctx.signal?.addEventListener("abort", forwardCtxAbort, { once: true });

			postMessage("/citecheck started. Use /citecheck stop to stop it and terminate launched process trees.", "info");

			const runPromise = (async () => {
				try {
					await runCitecheck(args, {
						cwd: ctx.cwd,
						exec: trackedExec.exec,
						signal: controller.signal,
						hasUI: ctx.hasUI,
						ui: {
							notify: (message, level = "info") => postMessage(message, level),
							confirm: ctx.ui.confirm?.bind(ctx.ui),
							setStatus: (_key, _value) => {
								// Deliberately no-op: /citecheck emits persistent progress messages
								// instead of replacing prior text with transient status lines.
							},
						},
						progress: (message, level = "info") => postMessage(message, level),
						getCommands: () => pi.getCommands(),
					});
				} catch (error) {
					if (isCitecheckAbort(error, controller.signal)) {
						postMessage("/citecheck stopped; launched processes were terminated.", "warning");
					} else {
						const message = error instanceof Error ? error.message : String(error);
						postMessage(`/citecheck failed: ${message}`, "error");
					}
				} finally {
					ctx.signal?.removeEventListener("abort", forwardCtxAbort);
					trackedExec.killAll();
					if (activeRun === run) activeRun = undefined;
					ctx.ui.setStatus?.("citecheck", undefined);
				}
			})();

			if (!ctx.hasUI) await runPromise;
		},
	});
}
