/**
 * Windows path utilities for the bash escape heuristic.
 *
 * On native Windows the model's "bash" commands are often PowerShell or cmd
 * syntax (`Remove-Item $env:USERPROFILE\Documents\x.pdf`, `del %USERPROFILE%\x`)
 * whose path arguments use backslashes, drive letters, and environment
 * variables the POSIX token scan never recognizes. `winPathCandidate` resolves
 * such a token to an absolute win32 path so the escape check can flag it.
 *
 * Pure and SDK-free: every path operation goes through `path.win32` and the
 * environment is injected, so the whole table is unit-tested on any platform.
 */

import path from "node:path";

/**
 * Normalize a path for Windows containment checks. Handles:
 * - Git Bash paths: /c/Users/... → C:\Users\...
 * - Drive-letter paths: C:\Users\... (passthrough)
 * - UNC paths: \\server\share (passthrough)
 * - Mixed slashes: C:/Users/... → C:\Users\...
 */
export function normalizeWindowsPath(p: string): string {
  if (!p) return p;

  // Git Bash / WSL-style: /c/Users/... → C:\Users\...
  const m = p.match(/^\/([a-zA-Z])\//);
  if (m) {
    const drive = m[1].toUpperCase();
    const rest = p.slice(m.index! + m[0].length);
    return drive + `:\\${rest.replace(/\//g, "\\")}`;
  }

  // Normalize mixed slashes to backslashes on Windows
  if (p.includes("/")) {
    return p.replace(/\//g, "\\");
  }

  return p;
}

/**
 * Check if a path is a Windows drive letter path (e.g., C:\, D:\).
 */
export function isDriveLetterPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p);
}

/**
 * Get the drive letter from a Windows path, or undefined.
 */
export function getDriveLetter(p: string): string | undefined {
  const m = /^[a-zA-Z]:/.exec(p);
  return m?.[0].slice(0, 1);
}

/** What `winPathCandidate` needs to expand a token: project root, home, env. */
export interface WinPathCtx {
  /** Absolute win32 project root (relative tokens resolve against it). */
  root: string;
  /** The user's home directory (`~`, `$HOME`). */
  home: string;
  /** Environment for `$env:X` / `%X%` / `$X` (looked up case-insensitively). */
  env: Record<string, string | undefined>;
}

/** PowerShell provider prefixes that still address the filesystem. */
const PROVIDER_PREFIX_RE = /^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/i;

/** A leading variable reference: `${env:X}`, `$env:X`, `${X}`, `$X`, `%X%`. */
const LEADING_VAR_RE = /^(?:\$\{env:(\w+)\}|\$env:(\w+)|\$\{(\w+)\}|\$(\w+)|%(\w+)%)(?=$|[\\/])/i;

function lookupEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === want && v) return v;
  }
  return undefined;
}

/** Expand a variable name to a path; HOME/PWD have shell-level meanings. */
function expandVar(name: string, ctx: WinPathCtx): string | undefined {
  const upper = name.toUpperCase();
  if (upper === "PWD") return ctx.root;
  if (upper === "HOME") return ctx.home;
  return lookupEnv(ctx.env, name);
}

/**
 * Resolve a shell token to an absolute win32 path, or undefined when the
 * token isn't path-like (or references a variable we can't expand — the
 * heuristic only flags what it can see; it is not the enforcement).
 *
 * Recognized: drive paths (`C:\x`, `c:/x`), drive-relative (`D:x`), UNC
 * (`\\srv\share`), Git Bash drive paths (`/c/x`), home (`~`, `~\x`, `~/x`),
 * variables (`$env:X`, `${env:X}`, `$X`, `${X}`, `%X%` — followed by a
 * separator or alone), and relative paths with a separator or `..`.
 * Other POSIX-absolute tokens (`/tmp/x`) return undefined so the caller's
 * POSIX check still handles them.
 */
export function winPathCandidate(tok: string, ctx: WinPathCtx): string | undefined {
  let t = tok.replace(/["'`]/g, "").trim();
  if (!t) return undefined;
  t = t.replace(PROVIDER_PREFIX_RE, "");

  const v = LEADING_VAR_RE.exec(t);
  if (v) {
    const name = v[1] ?? v[2] ?? v[3] ?? v[4] ?? v[5];
    const base = expandVar(name, ctx);
    if (!base) return undefined;
    t = base + t.slice(v[0].length);
  } else if (t === "~" || t.startsWith("~\\") || t.startsWith("~/")) {
    t = ctx.home + t.slice(1);
  }

  if (/^\/[a-zA-Z]\//.test(t)) return path.win32.normalize(normalizeWindowsPath(t));
  if (t.startsWith("/")) return undefined; // POSIX-absolute: left to the caller
  if (t.startsWith("\\\\")) return path.win32.normalize(t); // UNC
  if (isDriveLetterPath(t)) return path.win32.normalize(t);

  const driveRel = /^([a-zA-Z]):(.*)$/.exec(t);
  if (driveRel) {
    const [, drive, rest] = driveRel;
    if (drive.toUpperCase() !== getDriveLetter(ctx.root)?.toUpperCase()) {
      return path.win32.normalize(`${drive}:\\${rest}`);
    }
    return path.win32.resolve(ctx.root, rest);
  }

  if (t.includes("\\") || t.includes("/") || t === "..") return path.win32.resolve(ctx.root, t);
  return undefined;
}

/**
 * Lexical, case-insensitive containment test for absolute win32 paths: true
 * when `target` is not `root` or below it. A sibling sharing the root's
 * prefix (`C:\ws\proj2` vs `C:\ws\proj`) is outside.
 */
export function isOutsideWin(root: string, target: string): boolean {
  const rel = path.win32.relative(root.toLowerCase(), target.toLowerCase());
  return rel === ".." || rel.startsWith("..\\") || path.win32.isAbsolute(rel);
}
