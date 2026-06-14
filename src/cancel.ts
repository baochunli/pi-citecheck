export class CitecheckAbortError extends Error {
	constructor(message = "/citecheck stopped.") {
		super(message);
		this.name = "CitecheckAbortError";
	}
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = (signal as AbortSignal & { reason?: unknown }).reason;
	if (reason instanceof CitecheckAbortError) throw reason;
	if (reason instanceof Error) throw new CitecheckAbortError(reason.message);
	if (typeof reason === "string" && reason.trim()) throw new CitecheckAbortError(reason);
	throw new CitecheckAbortError();
}

export function isCitecheckAbort(error: unknown, signal?: AbortSignal): boolean {
	return error instanceof CitecheckAbortError || signal?.aborted === true;
}
