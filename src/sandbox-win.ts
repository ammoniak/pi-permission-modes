/**
 * Pure helpers for the native Windows sandbox backend (sandbox-runtime's
 * `srt-win`, which runs commands as a dedicated `srt-sandbox` user).
 *
 * That backend only ADDS permission entries for the sandbox user, so it is
 * only as tight as the machine's existing ACLs. Folders created at a drive
 * root inherit `Authenticated Users: Modify`, which the sandbox user holds
 * too, and projects inside the user profile have parents the sandbox user
 * can't even stat (git then fails). SandboxController runs `probeScript`
 * inside the sandbox before trusting it and degrades on either finding.
 *
 * SDK-free and platform-independent (`path.win32`, injected env/fs), so it
 * unit-tests on any host.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isOutsideWin } from "./win-paths.ts";

/**
 * Where the `srt-win.exe` helper is staged: `%LOCALAPPDATA%\pi-permission-modes\
 * srt-win-<hash>\`. The name carries the helper's hash, so a copy is reused
 * only when it is byte-identical.
 */
export function stagedSrtWinPath(localAppData: string, bundledExe: string, content: Buffer): string {
  const tag = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return path.win32.join(localAppData, "pi-permission-modes", `srt-win-${tag}`, path.win32.basename(bundledExe));
}

/**
 * Stage the bundled `srt-win.exe` where the sandbox user can launch it but
 * nobody else can change it. The extension usually lives in the user profile,
 * which the sandbox user can't open. The staged folder stays in the profile
 * (so no other account can create or plant files there) and gets one extra
 * ACE: read/execute for Users. The sandbox user reaches it through its
 * bypass-traverse right. Returns the staged path.
 */
export function stageSrtWin(bundledExe: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!env.LOCALAPPDATA) throw new Error("cannot stage srt-win: LOCALAPPDATA is not set");
  const content = readFileSync(bundledExe);
  const staged = stagedSrtWinPath(env.LOCALAPPDATA, bundledExe, content);
  if (existsSync(staged) && readFileSync(staged).equals(content)) return staged;
  const dir = path.win32.dirname(staged);
  mkdirSync(dir, { recursive: true });
  execFileSync("icacls", [dir, "/grant", "*S-1-5-32-545:(OI)(CI)RX"], { windowsHide: true, stdio: "ignore" });
  copyFileSync(bundledExe, staged);
  return staged;
}

/**
 * Locate a machine-wide Git Bash `bash.exe`. It is derived from `git.exe`
 * directories on PATH (`<Git>\cmd`, `<Git>\bin`, `<Git>\mingw64\bin`), then
 * the Program Files defaults. Installs under the user profile are skipped:
 * the sandbox user cannot open them.
 */
export function findGitBash(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  const candidates: string[] = [];
  for (const dir of (env.PATH ?? env.Path ?? "").split(";")) {
    if (dir && exists(path.win32.join(dir, "git.exe"))) {
      candidates.push(path.win32.resolve(dir, "..", "bin", "bash.exe"), path.win32.resolve(dir, "..", "..", "bin", "bash.exe"));
    }
  }
  for (const pf of [env.ProgramFiles, env.ProgramW6432]) {
    if (pf) candidates.push(path.win32.join(pf, "Git", "bin", "bash.exe"));
  }
  const profile = env.USERPROFILE;
  return candidates.find((c) => exists(c) && !(profile && !isOutsideWin(profile, c)));
}

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Bash `export …; ` prefix carrying the host git identity (empty when unset). */
export function gitIdentityPrefix(name?: string, email?: string): string {
  const vars: string[] = [];
  if (name) vars.push(`GIT_AUTHOR_NAME=${sq(name)}`, `GIT_COMMITTER_NAME=${sq(name)}`);
  if (email) vars.push(`GIT_AUTHOR_EMAIL=${sq(email)}`, `GIT_COMMITTER_EMAIL=${sq(email)}`);
  return vars.length ? `export ${vars.join(" ")}; ` : "";
}

/** The host user's git `user.name` / `user.email` as seen from `cwd` (undefined when unset). */
export function readGitIdentity(cwd: string): { name?: string; email?: string } {
  const get = (key: string): string | undefined => {
    try {
      return execFileSync("git", ["config", "--get", key], { cwd, encoding: "utf8", windowsHide: true }).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  return { name: get("user.name"), email: get("user.email") };
}

/**
 * Folders that must NOT be writable from inside the sandbox: the project's
 * parent (sibling projects), the drive root, and the folder holding
 * `srt-win.exe` (a writable helper would let the sandbox rewrite itself).
 */
export function probeTargets(cwd: string, srtWinExe: string): string[] {
  const norm = (p: string) => path.win32.normalize(p);
  const root = path.win32.parse(norm(cwd)).root;
  const targets = [path.win32.dirname(norm(cwd)), root, path.win32.dirname(norm(srtWinExe))];
  return [...new Set(targets.map(norm))];
}

const PROBE_TAG = "PI-SRT-PROBE";
const bashPath = (p: string): string => p.replace(/\\/g, "/");

/**
 * Bash run inside the sandbox: reports each target it can create a file in,
 * and whether it can stat the project's parent (git needs to).
 */
export function probeScript(cwd: string, targets: string[], nonce: string): string {
  const lines: string[] = [];
  const parent = path.win32.dirname(path.win32.normalize(cwd));
  if (parent !== path.win32.normalize(cwd)) {
    lines.push(`ls -ld ${sq(bashPath(parent))} >/dev/null 2>&1 || echo ${sq(`${PROBE_TAG} HIDDEN ${parent}`)}`);
  }
  for (const t of targets) {
    const f = bashPath(path.win32.join(t, `.pi-srt-probe-${nonce}`));
    lines.push(`if ( : > ${sq(f)} ) 2>/dev/null; then rm -f ${sq(f)}; echo ${sq(`${PROBE_TAG} WRITABLE ${t}`)}; fi`);
  }
  lines.push(`echo ${PROBE_TAG} DONE`);
  return lines.join("\n");
}

export interface ProbeResult {
  /** The probe ran to completion. */
  done: boolean;
  /** Targets the sandbox user could create files in. */
  writable: string[];
  /** The project's parent, when the sandbox user can't stat it. */
  hiddenParent?: string;
}

export function parseProbe(output: string): ProbeResult {
  const result: ProbeResult = { done: false, writable: [] };
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(PROBE_TAG + " ")) continue;
    const rest = line.slice(PROBE_TAG.length + 1);
    if (rest === "DONE") result.done = true;
    else if (rest.startsWith("WRITABLE ")) result.writable.push(rest.slice("WRITABLE ".length));
    else if (rest.startsWith("HIDDEN ")) result.hiddenParent = rest.slice("HIDDEN ".length);
  }
  return result;
}

/** Footer-sized reason the probe rejects the sandbox, or undefined when it passes. */
export function probeProblem(r: ProbeResult): string | undefined {
  if (!r.done) return "Windows sandbox self-check did not complete";
  if (r.writable.length) return `Windows sandbox off: ${r.writable.join(", ")} writable by the sandbox user`;
  if (r.hiddenParent) return `Windows sandbox off: sandbox user can't see ${r.hiddenParent} (git would fail)`;
  return undefined;
}

/** Longer explanation + fix for a failed probe, for the one-time notification. */
export function probeAdvice(r: ProbeResult): string {
  if (r.writable.length) {
    return (
      `The sandbox user can write to ${r.writable.join(", ")}. It only adds permissions for itself, and folders ` +
      "created at a drive root grant every local user Modify rights, so sibling projects (or the sandbox helper " +
      "itself) would be writable. Tighten the folder's ACL (see README → Windows) or move the project. " +
      "Until then bash asks before every command."
    );
  }
  if (r.hiddenParent) {
    return (
      `The sandbox user can't read ${r.hiddenParent}, so git and other tools fail inside the sandbox. ` +
      "This happens for projects inside your user profile. Move the project to a folder like C:\\src with a " +
      "tightened ACL (see README → Windows). Until then bash asks before every command."
    );
  }
  return "The sandbox self-check did not complete. Bash asks before every command.";
}

/**
 * Drop deny entries inside the host user's profile. The sandbox user can't
 * read the profile anyway, and stamping a deny there makes the runtime edit
 * the profile folder's own ACL, which Windows then re-applies across the whole
 * profile (minutes). Entries under a write grant are kept: there the grant
 * would otherwise open them up.
 */
export function dropRedundantProfileDenies(
  paths: string[] | undefined,
  allowWrite: string[] | undefined,
  profileDir: string | undefined,
  cwd: string,
): string[] | undefined {
  if (!paths || !profileDir) return paths;
  const resolve = (p: string) => path.win32.resolve(cwd, p === "~" ? profileDir : p.replace(/^~[\\/]/, `${profileDir}\\`));
  const grants = (allowWrite ?? []).map(resolve);
  return paths.filter((p) => {
    const abs = resolve(p);
    if (isOutsideWin(profileDir, abs)) return true;
    return grants.some((g) => !isOutsideWin(g, abs));
  });
}
