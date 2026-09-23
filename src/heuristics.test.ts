import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { bashConfirmReason, PRIVILEGE_RE } from "./heuristics.ts";

const ROOT = "/home/proj";

test("privilege escalation is flagged", () => {
  for (const cmd of ["sudo rm -rf /", "su -", "doas whoami", "pkexec id", "chroot /mnt"]) {
    assert.equal(bashConfirmReason(cmd, ROOT), "privilege escalation", cmd);
  }
  assert.ok(PRIVILEGE_RE.test("runuser -u root foo"));
});

test("out-of-project path tokens are flagged", () => {
  assert.match(bashConfirmReason("cat /etc/passwd", ROOT) ?? "", /path outside project/);
  assert.match(bashConfirmReason("ls ../sibling", ROOT) ?? "", /path outside project/);
  assert.match(bashConfirmReason(`cat ${os.homedir()}/.bashrc`, ROOT) ?? "", /path outside project/);
});

const WIN = {
  platform: "win32" as const,
  home: "C:\\Users\\u",
  env: { USERPROFILE: "C:\\Users\\u", TEMP: "C:\\Users\\u\\AppData\\Local\\Temp" },
};
const WIN_ROOT = "C:\\ws\\proj";

test("win32: PowerShell/cmd paths outside the project are flagged", () => {
  // The reported regression: this used to run silently in a "sandboxed" mode.
  assert.equal(
    bashConfirmReason("Remove-Item $env:USERPROFILE\\Documents\\Steuererklärung_2025.pdf", WIN_ROOT, WIN),
    "path outside project: $env:USERPROFILE\\Documents\\Steuererklärung_2025.pdf",
  );
  for (const cmd of [
    'Remove-Item "$env:USERPROFILE\\Documents\\x.pdf"',
    "del %USERPROFILE%\\x",
    "rm ~\\Documents\\x",
    "Remove-Item C:\\Users\\u\\x",
    "Copy-Item a.txt D:\\backup",
    "Remove-Item ..\\sibling\\x",
    "Remove-Item C:\\ws\\proj2\\x", // shares the root's prefix
    "Get-ChildItem $HOME\\Documents",
  ]) {
    assert.match(bashConfirmReason(cmd, WIN_ROOT, WIN) ?? "", /path outside project/, cmd);
  }
});

test("win32: in-project PowerShell/cmd commands and switches are not flagged", () => {
  for (const cmd of [
    "Remove-Item .\\build\\out.txt",
    "Get-Content src\\index.ts",
    "Remove-Item C:\\ws\\proj\\dist -Recurse",
    "cmd /c dir /s",
    "Write-Output $null",
    "npm test",
  ]) {
    assert.equal(bashConfirmReason(cmd, WIN_ROOT, WIN), undefined, cmd);
  }
});

test("win32: Windows elevation is privilege escalation", () => {
  for (const cmd of ["runas /user:Administrator cmd", "gsudo Remove-Item x", "Start-Process pwsh -Verb RunAs"]) {
    assert.equal(bashConfirmReason(cmd, WIN_ROOT, WIN), "privilege escalation", cmd);
  }
});

test("in-project commands are allowed", () => {
  assert.equal(bashConfirmReason("ls -la", ROOT), undefined);
  assert.equal(bashConfirmReason("cat src/index.ts", ROOT), undefined);
  assert.equal(bashConfirmReason("npm test", ROOT), undefined);
});

test("device pseudo-files are allowed (safe outside)", () => {
  assert.equal(bashConfirmReason("echo hi > /dev/null", ROOT), undefined);
  assert.equal(bashConfirmReason("cat /dev/urandom | head", ROOT), undefined);
});

// Locks the documented heuristic gaps: these SHOULD be caught by a real parser
// but are not (the OS sandbox is the real enforcement). If a future change makes
// the heuristic smarter, update these expectations deliberately.
test("known gaps: heuristic does not parse the shell", () => {
  // Path built via variable — not detected.
  assert.equal(bashConfirmReason("X=/etc/passwd; cat $X", ROOT), undefined);
  // Privilege escalation hidden in command substitution token boundary.
  assert.equal(bashConfirmReason("echo $(printf 's'; printf 'udo') ls", ROOT), undefined);
});
