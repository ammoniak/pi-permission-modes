/**
 * Small dependency-free utilities. Kept SDK-free so they can be unit-tested in
 * plain Node without the pi host.
 */

/** True when an error is a "module/package not found" failure (any of Node's spellings). */
export function isModuleNotFound(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === "ERR_MODULE_NOT_FOUND" ||
    e?.code === "MODULE_NOT_FOUND" ||
    /cannot find (module|package)/i.test(e?.message ?? "")
  );
}

/** Options bash operations receive per run (output sink, abort signal, timeout in seconds). */
export interface RunOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
}

/**
 * Stream a spawned child's output to `onData` and settle when it exits:
 * resolves `{exitCode}`, or rejects with `aborted` / `timeout:<s>` after
 * calling `kill`. `onClose` runs once the child has exited, before settling.
 */
export function superviseChild(
  child: import("node:child_process").ChildProcess,
  kill: () => void,
  { onData, signal, timeout }: RunOptions,
  onClose?: () => void,
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeout * 1000);
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      onClose?.();
      if (signal?.aborted) reject(new Error("aborted"));
      else if (timedOut) reject(new Error(`timeout:${timeout}`));
      else resolve({ exitCode: code });
    });
  });
}
