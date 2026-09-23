/**
 * Bash command heuristics.
 *
 * A best-effort scan of a bash command string for privilege escalation and
 * out-of-project path tokens. This is NOT a real shell parser and can be fooled
 * (`bash -c '...'`, command substitution, variable-built paths). It drives the
 * Build-mode confirmation UX only; the OS sandbox is the real enforcement.
 *
 * Pure (no `pi`/`ctx`) so the known-gap behavior can be locked down with tests.
 */

import os from "node:os";
import path from "node:path";
import { isOutside, SAFE_OUTSIDE_RE } from "./paths.ts";
import { isOutsideWin, winPathCandidate } from "./win-paths.ts";

/** Privilege escalation / run-as-other-user (incl. Windows `runas` / `gsudo`). */
export const PRIVILEGE_RE = /\b(sudo|su|doas|pkexec|runuser|setpriv|chroot|runas|gsudo)\b/i;

/** Platform and environment the path check runs against (injected in tests). */
export interface PathCheckOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
}

/**
 * True when a single command token names a path outside `root`. On win32 the
 * token is first resolved as a Windows path (`C:\x`, `~\x`, `$env:X\x`,
 * `%X%\x`, `..\x`); tokens that aren't Windows-shaped fall through to the
 * POSIX check (`/x`, `~/x`, `a/b`, `..`).
 */
export function isOutsideToken(tok: string, root: string, opts: PathCheckOptions = {}): boolean {
  if ((opts.platform ?? process.platform) === "win32") {
    // Single-letter switches (`cmd /c`, `dir /s`, `findstr /i`), not paths.
    if (/^\/[a-zA-Z?]$/.test(tok)) return false;
    const abs = winPathCandidate(tok, { root, home: opts.home ?? os.homedir(), env: opts.env ?? process.env });
    if (abs !== undefined) {
      // Lexical check always; on a real Windows host also the canonical one,
      // so a junction/symlink inside the project can't hide an escape.
      return isOutsideWin(root, abs) || (process.platform === "win32" && isOutside(root, abs));
    }
  }
  let target: string | undefined;
  if (tok.startsWith("/")) target = tok;
  else if (tok === "~" || tok.startsWith("~/")) target = path.join(opts.home ?? os.homedir(), tok.slice(1));
  else if (tok.includes("/") || tok === "..") target = path.resolve(root, tok);
  else return false;
  if (SAFE_OUTSIDE_RE.test(target)) return false;
  return isOutside(root, target);
}

/**
 * Returns a human-readable reason to prompt before running `command`, or
 * undefined when the heuristic finds nothing concerning. `root` is the project
 * directory used to classify path tokens as in/out of project.
 */
export function bashConfirmReason(command: string, root: string, opts: PathCheckOptions = {}): string | undefined {
  if (PRIVILEGE_RE.test(command)) return "privilege escalation";
  for (const raw of command.split(/[\s;|&()<>]+/).filter(Boolean)) {
    const tok = raw.replace(/^['"]+|['"]+$/g, "");
    if (!tok) continue;
    if (isOutsideToken(tok, root, opts)) return `path outside project: ${tok}`;
  }
  return undefined;
}
