import assert from "node:assert/strict";
import test from "node:test";
import {
  findGitBash,
  gitIdentityPrefix,
  parseProbe,
  probeAdvice,
  probeProblem,
  probeScript,
  probeTargets,
  stagedSrtWinPath,
} from "./sandbox-win.ts";

const existsIn = (files: string[]) => (p: string) => files.map((f) => f.toLowerCase()).includes(p.toLowerCase());

test("findGitBash: derives bash.exe from git.exe on PATH (cmd, bin, mingw64\\bin)", () => {
  const bash = "D:\\Tools\\Git\\bin\\bash.exe";
  for (const gitDir of ["D:\\Tools\\Git\\cmd", "D:\\Tools\\Git\\bin", "D:\\Tools\\Git\\mingw64\\bin"]) {
    const env = { PATH: `C:\\Windows;${gitDir}` };
    assert.equal(findGitBash(env, existsIn([`${gitDir}\\git.exe`, bash])), bash, gitDir);
  }
});

test("findGitBash: falls back to Program Files", () => {
  const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
  assert.equal(findGitBash({ PATH: "", ProgramFiles: "C:\\Program Files" }, existsIn([bash])), bash);
});

test("findGitBash: skips per-user installs the sandbox user can't open", () => {
  const userGit = "C:\\Users\\me\\AppData\\Local\\Programs\\Git";
  const env = { PATH: `${userGit}\\cmd`, USERPROFILE: "C:\\Users\\me" };
  assert.equal(findGitBash(env, existsIn([`${userGit}\\cmd\\git.exe`, `${userGit}\\bin\\bash.exe`])), undefined);
});

test("findGitBash: never picks System32's WSL bash.exe", () => {
  const env = { PATH: "C:\\Windows\\System32" };
  assert.equal(findGitBash(env, existsIn(["C:\\Windows\\System32\\bash.exe"])), undefined);
});

test("gitIdentityPrefix: exports quoted identity, empty when unset", () => {
  assert.equal(gitIdentityPrefix(), "");
  assert.equal(
    gitIdentityPrefix("Ann O'Neil", "ann@x.io"),
    "export GIT_AUTHOR_NAME='Ann O'\\''Neil' GIT_COMMITTER_NAME='Ann O'\\''Neil' " +
      "GIT_AUTHOR_EMAIL='ann@x.io' GIT_COMMITTER_EMAIL='ann@x.io'; ",
  );
  assert.equal(gitIdentityPrefix(undefined, "a@b"), "export GIT_AUTHOR_EMAIL='a@b' GIT_COMMITTER_EMAIL='a@b'; ");
});

test("probeTargets: parent, drive root and the srt-win folder, de-duplicated", () => {
  assert.deepEqual(probeTargets("C:\\ws\\proj", "C:\\ws\\proj\\node_modules\\srt\\srt-win.exe"), [
    "C:\\ws",
    "C:\\",
    "C:\\ws\\proj\\node_modules\\srt",
  ]);
  assert.deepEqual(probeTargets("C:\\proj", "C:\\ext\\srt-win.exe"), ["C:\\", "C:\\ext"]);
});

test("probeScript: stats the parent and tries one file per target", () => {
  const s = probeScript("C:\\ws\\proj", ["C:\\ws", "C:\\"], "abc");
  assert.match(s, /ls -ld 'C:\/ws'/);
  assert.match(s, /: > 'C:\/ws\/\.pi-srt-probe-abc'/);
  assert.match(s, /: > 'C:\/\.pi-srt-probe-abc'/);
  assert.match(s, /PI-SRT-PROBE DONE$/);
  // A project at a drive root has no parent to stat.
  assert.doesNotMatch(probeScript("C:\\", ["C:\\"], "abc"), /ls -ld/);
});

test("parseProbe + probeProblem: pass, writable, hidden parent, incomplete", () => {
  const ok = parseProbe("noise\r\nPI-SRT-PROBE DONE\r\n");
  assert.deepEqual(ok, { done: true, writable: [] });
  assert.equal(probeProblem(ok), undefined);

  const w = parseProbe("PI-SRT-PROBE WRITABLE C:\\ws\nPI-SRT-PROBE WRITABLE C:\\\nPI-SRT-PROBE DONE\n");
  assert.deepEqual(w.writable, ["C:\\ws", "C:\\"]);
  assert.match(probeProblem(w)!, /C:\\ws, C:\\ writable/);
  assert.match(probeAdvice(w), /Tighten the folder's ACL/);

  const h = parseProbe("PI-SRT-PROBE HIDDEN C:\\Users\\me\\code\nPI-SRT-PROBE DONE\n");
  assert.match(probeProblem(h)!, /can't see C:\\Users\\me\\code/);
  assert.match(probeAdvice(h), /inside your user profile/);

  assert.match(probeProblem(parseProbe("PI-SRT-PROBE WRITABLE C:\\ws\n"))!, /did not complete/);
});

test("stagedSrtWinPath: per-hash folder under LOCALAPPDATA", () => {
  const local = "C:\\Users\\me\\AppData\\Local";
  const p = stagedSrtWinPath(local, "C:\\x\\vendor\\srt-win.exe", Buffer.from("abc"));
  assert.match(p, /^C:\\Users\\me\\AppData\\Local\\pi-permission-modes\\srt-win-[0-9a-f]{12}\\srt-win\.exe$/);
  // A different helper build lands in a different folder.
  assert.notEqual(p, stagedSrtWinPath(local, "C:\\x\\vendor\\srt-win.exe", Buffer.from("abd")));
});
