export class VoiceTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms`);
    this.name = "VoiceTimeoutError";
  }
}

export class ParentAbortError extends Error {
  constructor(reason?: unknown) {
    super(reason instanceof Error ? reason.message : "aborted");
    this.name = "ParentAbortError";
  }
}

export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parentSignal: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let rejectOuter: ((reason: unknown) => void) | undefined;
  const rejectOnce = (reason: unknown) => {
    if (settled) return;
    settled = true;
    rejectOuter?.(reason);
  };
  const onAbort = () => {
    const reason = parentSignal.reason ?? new ParentAbortError();
    controller.abort(reason);
    rejectOnce(reason);
  };
  parentSignal.addEventListener("abort", onAbort, { once: true });
  try {
    return await new Promise<T>((resolve, reject) => {
      rejectOuter = reject;
      if (parentSignal.aborted) onAbort();
      timer = setTimeout(() => {
        const error = new VoiceTimeoutError(ms);
        controller.abort(error);
        rejectOnce(error);
      }, ms);
      void run(controller.signal).then(
        (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        },
        (error) => rejectOnce(error)
      );
    });
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    parentSignal.removeEventListener("abort", onAbort);
  }
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason;
}
