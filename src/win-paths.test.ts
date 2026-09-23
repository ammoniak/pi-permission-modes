/**
 * Unit tests for win-paths.ts — pure Windows path normalization and the token
 * resolver behind the win32 bash escape heuristic.
 *
 * These functions are pure and SDK-free, so they test easily without mocking.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeWindowsPath,
  isDriveLetterPath,
  getDriveLetter,
  isOutsideWin,
  winPathCandidate,
  type WinPathCtx,
} from "./win-paths.ts";

// ---------------------------------------------------------------------------
// normalizeWindowsPath
// ---------------------------------------------------------------------------

test("normalizeWindowsPath: Git Bash paths", () => {
  assert.equal(normalizeWindowsPath("/c/Users/proj/src"), "C:\\Users\\proj\\src");
  assert.equal(normalizeWindowsPath("/d/workspace/main.ts"), "D:\\workspace\\main.ts");
});

test("normalizeWindowsPath: mixed slashes", () => {
  assert.equal(normalizeWindowsPath("C:/Users/proj/src"), "C:\\Users\\proj\\src");
  assert.equal(normalizeWindowsPath("a/b/c/d"), "a\\b\\c\\d");
});

test("normalizeWindowsPath: passthrough (already backslashes, drive-letter)", () => {
  assert.equal(normalizeWindowsPath("C:\\Users\\proj"), "C:\\Users\\proj");
});

test("normalizeWindowsPath: empty/null", () => {
  assert.equal(normalizeWindowsPath(""), ""); // returns empty string for empty input
  assert.equal(normalizeWindowsPath(null as unknown as string), null); // null input returns null
});

test("normalizeWindowsPath: UNC paths passthrough", () => {
  assert.equal(normalizeWindowsPath("\\\\server\\share"), "\\\\server\\share");
});

// ---------------------------------------------------------------------------
// isDriveLetterPath / getDriveLetter
// ---------------------------------------------------------------------------

test("isDriveLetterPath: recognizes drive-letter paths", () => {
  assert.ok(isDriveLetterPath("C:\\Users\\proj"));
  assert.ok(isDriveLetterPath("D:/workspace"));
  assert.ok(isDriveLetterPath("Z:\\"));
  assert.ok(isDriveLetterPath("Z:/"));
});

test("isDriveLetterPath: rejects non-drive paths", () => {
  assert.equal(isDriveLetterPath("/c/Users"), false);
  // C:\Windows\System32 IS a drive-letter path — the function matches any X:\ pattern.
  assert.equal(isDriveLetterPath("C:\\Windows\\System32"), true);
  assert.equal(isDriveLetterPath("no/drive"), false);
  assert.equal(isDriveLetterPath(""), false);
  // Just "C:" without a trailing slash is NOT a drive-letter path.
  assert.equal(isDriveLetterPath("C:"), false);
});

test("getDriveLetter: extracts drive letter", () => {
  assert.equal(getDriveLetter("C:\\Users"), "C");
  assert.equal(getDriveLetter("Z:\\temp"), "Z");
});

test("getDriveLetter: returns undefined for non-drive paths", () => {
  assert.equal(getDriveLetter("/c/Users"), undefined);
  assert.equal(getDriveLetter("no/drive"), undefined);
  assert.equal(getDriveLetter(""), undefined);
});

// ---------------------------------------------------------------------------
// winPathCandidate
// ---------------------------------------------------------------------------

const ctx: WinPathCtx = {
  root: "C:\\ws\\proj",
  home: "C:\\Users\\u",
  env: { USERPROFILE: "C:\\Users\\u", APPDATA: "C:\\Users\\u\\AppData\\Roaming", SystemRoot: "C:\\Windows" },
};

test("winPathCandidate: resolves Windows-shaped tokens", () => {
  const cases: Array<[string, string]> = [
    // the reported regression
    ["$env:USERPROFILE\\Documents\\Steuererklärung_2025.pdf", "C:\\Users\\u\\Documents\\Steuererklärung_2025.pdf"],
    ["${env:USERPROFILE}\\x", "C:\\Users\\u\\x"],
    ["$env:userprofile/x", "C:\\Users\\u\\x"],
    ["%USERPROFILE%\\x", "C:\\Users\\u\\x"],
    ["%appdata%\\x", "C:\\Users\\u\\AppData\\Roaming\\x"],
    ["$HOME/x", "C:\\Users\\u\\x"],
    ["$HOME", "C:\\Users\\u"],
    ["$USERPROFILE/x", "C:\\Users\\u\\x"],
    ["~", "C:\\Users\\u"],
    ["~\\x", "C:\\Users\\u\\x"],
    ["~/x", "C:\\Users\\u\\x"],
    ["C:\\Users\\u\\x", "C:\\Users\\u\\x"],
    ["c:/users/u/x", "c:\\users\\u\\x"],
    ["D:foo", "D:\\foo"],
    ["C:src\\a", "C:\\ws\\proj\\src\\a"],
    ["\\\\srv\\share\\x", "\\\\srv\\share\\x"],
    ["/c/Users/u/x", "C:\\Users\\u\\x"],
    ["..\\x", "C:\\ws\\x"],
    ["..", "C:\\ws"],
    [".\\src\\a", "C:\\ws\\proj\\src\\a"],
    ["src/a", "C:\\ws\\proj\\src\\a"],
    ["$PWD\\src", "C:\\ws\\proj\\src"],
    ['"$env:USERPROFILE"\\Documents', "C:\\Users\\u\\Documents"],
    ["FileSystem::C:\\x", "C:\\x"],
    ["Microsoft.PowerShell.Core\\FileSystem::C:\\x", "C:\\x"],
  ];
  for (const [tok, want] of cases) assert.equal(winPathCandidate(tok, ctx), want, tok);
});

test("winPathCandidate: non-path or unexpandable tokens are undefined", () => {
  for (const tok of ["git", "-Recurse", "$env:UNKNOWN\\x", "$null", "$_.FullName", "/tmp/x", "/dev/null", ""]) {
    assert.equal(winPathCandidate(tok, ctx), undefined, tok);
  }
});

// ---------------------------------------------------------------------------
// isOutsideWin
// ---------------------------------------------------------------------------

test("isOutsideWin: containment is case-insensitive and boundary-aware", () => {
  assert.equal(isOutsideWin("C:\\ws\\proj", "C:\\ws\\proj"), false);
  assert.equal(isOutsideWin("C:\\ws\\proj", "c:\\WS\\Proj\\src\\a.ts"), false);
  assert.equal(isOutsideWin("C:\\ws\\proj", "C:\\ws\\proj2\\x"), true); // prefix trap
  assert.equal(isOutsideWin("C:\\ws\\proj", "C:\\ws"), true);
  assert.equal(isOutsideWin("C:\\ws\\proj", "C:\\Users\\u\\Documents\\x.pdf"), true);
  assert.equal(isOutsideWin("C:\\ws\\proj", "D:\\ws\\proj"), true);
  assert.equal(isOutsideWin("C:\\ws\\proj", "\\\\srv\\share"), true);
});

