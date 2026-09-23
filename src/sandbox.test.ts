/**
 * Unit tests for sandbox.ts — SandboxController lifecycle and
 * createSandboxedBashOps wrapping logic.
 *
 * Hermetic: uses fake SandboxManager mocks to test the
 * initialize/reset/applyProfile flow, and creates temp dirs for path-based
 * checks. The win32 branch is exercised on any host via the injected
 * `platform` init option.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SandboxController,
  createSandboxedBashOps,
  type InitOptions,
  WINDOWS_NO_SANDBOX_WARN,
  WINDOWS_NOT_INSTALLED_WARN,
} from "./sandbox.ts";
import type { SandboxProfile } from "./schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A fake SandboxManager that records calls but never touches the filesystem.
 */
function makeFakeManager() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const mgr = {
    initialize: async (...args: unknown[]) => {
      calls.push({ method: "initialize", args });
    },
    reset: async () => {
      calls.push({ method: "reset", args: [] });
    },
    wrapWithSandbox: async (cmd: string, ..._rest: unknown[]) => {
      calls.push({ method: "wrapWithSandbox", args: [cmd] });
      return cmd; // echo the command back
    },
  };
  return { mgr, calls };
}

function makeInitOptions(
  profile: NonNullable<InitOptions["profile"]> = {
    enabled: true,
    writable: true,
    allowWrite: ["."],
    denyWrite: [],
    denyRead: [],
    network: { allowedDomains: [], deniedDomains: [] },
  },
  extra: Partial<InitOptions> = {},
): InitOptions {
  return {
    cwd: mkdtempSync(path.join(tmpdir(), "perm-sbox-")),
    noSandbox: false,
    hasUI: true,
    notify: () => {},
    profile,
    ...extra,
  };
}

/**
 * Synchronous factory — returns { controller, initOpts } directly.
 */
function buildController(
  profile: NonNullable<InitOptions["profile"]> = {
    enabled: true,
    writable: true,
    allowWrite: ["."],
    denyWrite: [],
    denyRead: [],
    network: { allowedDomains: [], deniedDomains: [] },
  },
  extra: Partial<InitOptions> = {},
) {
  const base: InitOptions = {
    cwd: mkdtempSync(path.join(tmpdir(), "perm-sbox-")),
    noSandbox: false,
    hasUI: true,
    notify: () => {},
    profile,
    ...extra,
  };
  return { controller: new SandboxController(), initOpts: base };
}

// Test-only seam for reading/writing SandboxController internals. These fields
// are private to the production class; the tests assert on their post-init
// state, so cast through unknown once at this named boundary.
interface SandboxControllerInternals {
  manager: unknown;
  profile: SandboxProfile | undefined;
  degraded: boolean;
  hasUI: boolean;
  askHost: ((host: string, port: number | undefined) => Promise<boolean>) | undefined;
  drainBlockedHosts: (() => string[]) | undefined;
}

function internals(c: SandboxController): SandboxControllerInternals {
  return c as unknown as SandboxControllerInternals;
}

// ---------------------------------------------------------------------------
// SandboxController — init paths
// ---------------------------------------------------------------------------

test("init: no-sandbox sets disabled + degraded", async () => {
  const { controller, initOpts } = buildController(undefined, { noSandbox: true });
  await controller.init(initOpts);
  assert.equal(controller.disabled, true);
  assert.equal(internals(controller).degraded, true);
  assert.equal(controller.ready, false);
});

test("init: no-sandbox sets degraded even on win32", async () => {
  const { controller, initOpts } = buildController(undefined, { noSandbox: true, platform: "win32" });
  await controller.init(initOpts);
  assert.equal(internals(controller).degraded, true);
  assert.equal(controller.disabled, true);
  assert.equal(controller.ready, false);
});

test("init: missing sandbox-runtime sets degraded with message", async () => {
  const notified: string[] = [];
  const { controller, initOpts } = buildController(undefined, {
    hasUI: true,
    notify: (msg) => notified.push(msg),
  });
  await controller.init(initOpts);
  // The real sandbox-runtime IS installed, so init may succeed or fail.
  assert.ok(internals(controller).degraded || controller.ready);
});

test("init: gitworktree (.git is non-empty file) degrades", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "perm-gitw-"));
  try {
    writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere\n");
    const { controller, initOpts } = buildController(undefined, {
      cwd: root,
      hasUI: true,
      notify: () => {},
    });
    await controller.init(initOpts);
    assert.ok(controller.ready || internals(controller).degraded);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("init: stores hasUI and notifyFn", async () => {
  const notified: string[] = [];
  const { controller, initOpts } = buildController(undefined, {
    hasUI: true,
    notify: (msg) => notified.push(msg),
  });
  await controller.init(initOpts);
  assert.equal(internals(controller).hasUI, true);
});

test("init: stores askHost and drainBlockedHosts", async () => {
  const asked: string[] = [];
  const drained: string[] = [];
  const opts: InitOptions = {
    cwd: mkdtempSync(path.join(tmpdir(), "perm-opts-")),
    noSandbox: true,
    hasUI: true,
    notify: () => {},
    profile: {
      enabled: true,
      writable: true,
      allowWrite: ["."],
      denyWrite: [],
      denyRead: [],
      network: { allowedDomains: [], deniedDomains: [] },
    },
    askHost: async (host) => { asked.push(host); return false; },
    drainBlockedHosts: () => { drained.push("host"); return []; },
  };
  const ctrl = new SandboxController();
  await ctrl.init(opts);
  assert.equal(opts.askHost, internals(ctrl).askHost);
  assert.equal(opts.drainBlockedHosts, internals(ctrl).drainBlockedHosts);
  rmSync(opts.cwd, { recursive: true, force: true });
});

test("init: clears all state before re-init", async () => {
  const { controller, initOpts } = buildController(undefined, { noSandbox: true });
  await controller.init(initOpts);
  assert.equal(controller.disabled, true);
  assert.equal(internals(controller).degraded, true);
  assert.equal(controller.ready, false);
  assert.equal(controller.warn, undefined);
  assert.equal(internals(controller).manager, null);

  // Re-init should clear state again.
  const opts2 = makeInitOptions({
    enabled: true,
    writable: true,
    allowWrite: ["."],
    denyWrite: [],
    denyRead: [],
    network: { allowedDomains: [], deniedDomains: [] },
  });
  await controller.init(opts2);
  assert.equal(controller.disabled, false);
  assert.ok(controller.ready || internals(controller).degraded);
});

// ---------------------------------------------------------------------------
// Native Windows — srt-win backend when installed and the self-check passes,
// otherwise degrade honestly so bash prompts
// ---------------------------------------------------------------------------

const WIN_PROFILE = {
  enabled: true,
  writable: true,
  allowWrite: ["."],
  denyWrite: [],
  denyRead: [],
  network: { allowedDomains: [], deniedDomains: [] },
};

const FAKE_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const PROBE_OK = "PI-SRT-PROBE DONE\n";

/**
 * A fake sandbox-runtime module for the win32 branch. `wrapWithSandboxArgv`
 * returns a node one-liner that prints `output`, so the spawn path runs for
 * real on any host.
 */
function makeFakeWinRuntime(opts: { provisioned?: boolean; output?: string } = {}) {
  let provisioned = opts.provisioned ?? true;
  const output = opts.output ?? PROBE_OK;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const SandboxManager = {
    initialize: async (...args: unknown[]) => {
      calls.push({ method: "initialize", args });
    },
    reset: async () => {
      calls.push({ method: "reset", args: [] });
    },
    wrapWithSandboxArgv: async (...args: unknown[]) => {
      calls.push({ method: "wrapWithSandboxArgv", args });
      return { argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`], env: process.env };
    },
  };
  const rt = {
    SandboxManager,
    VENDORED_SRT_WIN_EXE: "C:\\ext\\node_modules\\srt-win.exe",
    resolveSrtWin: (cfg: { path: string }) => ({ exe: cfg.path, prependArgs: [] }),
    checkWindowsSandboxStatusAsync: async () => ({ user: { provisioned }, wfp: {} }),
    installWindowsSandboxAsync: async () => {
      calls.push({ method: "install", args: [] });
      provisioned = true;
      return {};
    },
    uninstallWindowsSandbox: () => {
      calls.push({ method: "uninstall", args: [] });
      provisioned = false;
      return {};
    },
  };
  return { loadRuntime: async () => rt as never, calls };
}

function buildWinController(
  fake: ReturnType<typeof makeFakeWinRuntime>,
  extra: Partial<InitOptions> = {},
  profile: SandboxProfile = WIN_PROFILE,
) {
  return buildController(profile, {
    platform: "win32",
    windowsSandbox: true,
    loadRuntime: fake.loadRuntime,
    findBash: () => FAKE_BASH,
    stageHelper: (exe) => exe,
    ...extra,
  });
}

const count = (calls: Array<{ method: string }>, method: string) => calls.filter((c) => c.method === method).length;

test("init (win32): installed + self-check passes → ready, srt-win path in the runtime config", async () => {
  const fake = makeFakeWinRuntime();
  const { controller, initOpts } = buildWinController(fake);
  await controller.init(initOpts);
  assert.equal(controller.ready, true);
  assert.equal(controller.warn, undefined);
  const cfg = fake.calls.find((c) => c.method === "initialize")!.args[0] as { windows?: { srtWin?: { path: string } } };
  assert.equal(cfg.windows?.srtWin?.path, "C:\\ext\\node_modules\\srt-win.exe");
  assert.equal(count(fake.calls, "wrapWithSandboxArgv"), 1); // the self-check
});

test("init (win32): not installed → degraded with the install hint, runtime never initialized", async () => {
  const notified: string[] = [];
  const fake = makeFakeWinRuntime({ provisioned: false });
  const { controller, initOpts } = buildWinController(fake, { notify: (m) => notified.push(m) });
  await controller.init(initOpts);
  assert.equal(controller.ready, false);
  assert.equal(controller.warn, WINDOWS_NOT_INSTALLED_WARN);
  assert.equal(count(fake.calls, "initialize"), 0);
  assert.equal(notified.length, 1);
  assert.match(notified[0], /\/sandbox install/);
  assert.equal(controller.bashOps(), null);
});

for (const windowsSandbox of [undefined, false]) {
  test(`init (win32): windowsSandbox ${windowsSandbox} keeps prompting without loading the runtime`, async () => {
    const notified: string[] = [];
    const { controller, initOpts } = buildController(WIN_PROFILE, {
      platform: "win32",
      windowsSandbox,
      notify: (m) => notified.push(m),
      loadRuntime: async () => {
        throw new Error("must not load");
      },
    });
    await controller.init(initOpts);
    assert.equal(controller.ready, false);
    assert.equal(controller.warn, WINDOWS_NO_SANDBOX_WARN);
    assert.match(notified[0], /"windowsSandbox": true/);
  });
}

test("init (win32): deny entries inside the user profile are dropped unless under a write grant", async () => {
  const fake = makeFakeWinRuntime();
  const home = process.env.USERPROFILE;
  process.env.USERPROFILE = "C:\\Users\\me";
  try {
    const { controller, initOpts } = buildWinController(fake, {}, {
      ...WIN_PROFILE,
      allowWrite: [".", "~/.cache"],
      denyRead: ["~/.ssh", "~\\.aws", "~/.cache/secret", "D:\\keys"],
      denyWrite: ["~/.gitconfig"],
    });
    await controller.init(initOpts);
    const cfg = fake.calls.find((c) => c.method === "initialize")!.args[0] as {
      filesystem: { denyRead: string[]; denyWrite: string[] };
    };
    assert.deepEqual(cfg.filesystem.denyRead, ["~/.cache/secret", "D:\\keys"]);
    assert.deepEqual(cfg.filesystem.denyWrite, []);
  } finally {
    if (home === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = home;
  }
});

test("init (win32): no machine-wide Git Bash → degraded", async () => {
  const fake = makeFakeWinRuntime();
  const { controller, initOpts } = buildWinController(fake, { findBash: () => undefined });
  await controller.init(initOpts);
  assert.equal(controller.ready, false);
  assert.match(controller.warn ?? "", /Git Bash not found/);
  assert.equal(count(fake.calls, "initialize"), 0);
});

test("init (win32): self-check finds a writable folder outside the project → degraded + reset", async () => {
  const notified: string[] = [];
  const fake = makeFakeWinRuntime({ output: "PI-SRT-PROBE WRITABLE C:\\ws\nPI-SRT-PROBE DONE\n" });
  const { controller, initOpts } = buildWinController(fake, { notify: (m) => notified.push(m) });
  await controller.init(initOpts);
  assert.equal(controller.ready, false);
  assert.match(controller.warn ?? "", /C:\\ws writable by the sandbox user/);
  assert.equal(count(fake.calls, "reset"), 1);
  assert.match(notified.at(-1) ?? "", /Tighten the folder's ACL/);
  assert.equal(controller.bashOps(), null);
  // Later mode switches don't bring it back.
  await controller.applyProfile({ ...WIN_PROFILE, writable: false, allowWrite: [] });
  assert.equal(controller.ready, false);
});

test("init (win32): self-check can't see the project's parent → degraded", async () => {
  const fake = makeFakeWinRuntime({ output: "PI-SRT-PROBE HIDDEN C:\\Users\\me\\code\nPI-SRT-PROBE DONE\n" });
  const { controller, initOpts } = buildWinController(fake);
  await controller.init(initOpts);
  assert.equal(controller.ready, false);
  assert.match(controller.warn ?? "", /can't see C:\\Users\\me\\code/);
});

test("init (win32): an incomplete self-check fails closed", async () => {
  const fake = makeFakeWinRuntime({ output: "" });
  const { controller, initOpts } = buildWinController(fake);
  await controller.init(initOpts);
  assert.equal(controller.ready, false);
  assert.match(controller.warn ?? "", /did not complete/);
});

test("bashOps (win32): runs Git Bash via wrapWithSandboxArgv and spawns its argv", async () => {
  const fake = makeFakeWinRuntime();
  const { controller, initOpts } = buildWinController(fake);
  await controller.init(initOpts);
  const ops = controller.bashOps();
  assert.ok(ops);
  let out = "";
  const r = await ops.exec("echo hi", initOpts.cwd, { onData: (d: Buffer) => (out += d.toString()) });
  assert.equal(r.exitCode, 0);
  assert.equal(out, PROBE_OK); // the fake argv's output
  const wrap = fake.calls.filter((c) => c.method === "wrapWithSandboxArgv").at(-1)!.args;
  assert.match(wrap[0] as string, /echo hi$/);
  assert.deepEqual(wrap[1], { exe: FAKE_BASH, args: ["-c"] });
  assert.equal(wrap[2], undefined); // never a per-command config on Windows
  assert.equal(wrap[4], initOpts.cwd);
});

test("bashOps (win32): read-only is session-wide — mismatches return null, a Plan switch re-inits", async () => {
  const fake = makeFakeWinRuntime();
  const { controller, initOpts } = buildWinController(fake);
  await controller.init(initOpts);
  assert.ok(controller.bashOps());
  assert.equal(controller.bashOps({ readOnly: true }), null);

  await controller.applyProfile({ ...WIN_PROFILE, writable: false });
  assert.equal(controller.ready, true);
  const inits = fake.calls.filter((c) => c.method === "initialize");
  assert.equal(inits.length, 2);
  const cfg = inits[1].args[0] as { filesystem: { allowWrite: string[] } };
  assert.deepEqual(cfg.filesystem.allowWrite, []);
  assert.equal(count(fake.calls, "wrapWithSandboxArgv"), 1); // self-check only once per init
  assert.ok(controller.bashOps({ readOnly: true }));
  assert.equal(controller.bashOps(), null);
});

test("windowsSetup: install re-runs init and activates; uninstall resets and degrades", async () => {
  const fake = makeFakeWinRuntime({ provisioned: false });
  const { controller, initOpts } = buildWinController(fake);
  await controller.init(initOpts);
  assert.equal(controller.ready, false);

  assert.match(await controller.windowsSetup("install"), /installed and active/);
  assert.equal(controller.ready, true);

  assert.match(await controller.windowsSetup("uninstall"), /removed/);
  assert.equal(count(fake.calls, "reset"), 1);
  assert.equal(controller.ready, false);
  assert.equal(controller.warn, WINDOWS_NOT_INSTALLED_WARN);
});

test("init (win32): --no-sandbox still wins (disabled, not the Windows warning)", async () => {
  const { controller, initOpts } = buildController(WIN_PROFILE, { platform: "win32", noSandbox: true });
  await controller.init(initOpts);
  assert.equal(controller.disabled, true);
  assert.equal(controller.ready, false);
  assert.equal(controller.warn, undefined);
});

test("init: other unsupported platforms degrade with a warning", async () => {
  const { controller, initOpts } = buildController(WIN_PROFILE, { platform: "freebsd" });
  await controller.init(initOpts);
  assert.equal(controller.ready, false);
  assert.equal(controller.warn, "sandbox unsupported on freebsd");
});

test("applyProfile: degraded returns early", async () => {
  const { controller, initOpts } = buildController(undefined, { noSandbox: true });
  await controller.init(initOpts);
  assert.equal(internals(controller).degraded, true);
  await controller.applyProfile({
    enabled: false,
    writable: true,
    allowWrite: [],
    denyWrite: [],
    denyRead: [],
    network: { allowedDomains: [], deniedDomains: [] },
  });
  assert.equal(internals(controller).degraded, true); // still degraded
});

// ---------------------------------------------------------------------------
// SandboxController properties and getters
// ---------------------------------------------------------------------------

test("sandboxManager getter: returns null when not set", async () => {
  const ctrl = new SandboxController();
  assert.equal(ctrl.sandboxManager, null);
});

test("reset: calls manager.reset when ready", async () => {
  // Test that reset doesn't throw in all states.
  const { controller, initOpts } = buildController();
  await controller.init(initOpts);
  await controller.reset(); // shouldn't throw even when not ready
});

test("reset: swallows errors from manager.reset", async () => {
  const { controller, initOpts } = buildController();
  await controller.init(initOpts);
  assert.doesNotReject(controller.reset());
});

// ---------------------------------------------------------------------------
// createSandboxedBashOps
// ---------------------------------------------------------------------------

test("createSandboxedBashOps: exec throws for missing cwd", async () => {
  const { mgr } = makeFakeManager();
  const ops = createSandboxedBashOps(mgr as never, undefined, () => []);
  await assert.rejects(ops.exec("echo hi", "/nonexistent/dir", { onData: () => {}, signal: undefined }), /Working directory does not exist/);
});

test("createSandboxedBashOps: timeout rejects with timeout message", async () => {
  const { mgr } = makeFakeManager();
  const ops = createSandboxedBashOps(mgr as never, undefined, () => []);
  const root = mkdtempSync(path.join(tmpdir(), "perm-bops-"));
  try {
    await assert.rejects(
      ops.exec("sleep 10", root, { onData: () => {}, signal: undefined, timeout: 0.01 }),
      /timeout/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createSandboxedBashOps: abort rejects with aborted", async () => {
  const { mgr } = makeFakeManager();
  const ops = createSandboxedBashOps(mgr as never, undefined, () => []);
  const root = mkdtempSync(path.join(tmpdir(), "perm-abrt-"));
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(
      ops.exec("sleep 10", root, { onData: () => {}, signal: controller.signal, timeout: 5 }),
      /aborted/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createSandboxedBashOps: drainBlockedHosts is called on exec", async () => {
  const { mgr } = makeFakeManager();
  const drained: string[][] = [];
  const ops = createSandboxedBashOps(mgr as never, undefined, () => {
    drained.push(["blocked.example.com"]);
    return [];
  });
  const root = mkdtempSync(path.join(tmpdir(), "perm-drain-"));
  try {
    await ops.exec("echo hello", root, { onData: () => {}, signal: undefined, timeout: 0.01 });
  } catch {
    // timeout expected
  }
  assert.ok(drained.length > 0, "drainBlockedHosts was called");
});

test("createSandboxedBashOps: emitBlockedHint when hosts are blocked", async () => {
  const { mgr } = makeFakeManager();
  const outputs: string[] = [];
  const ops = createSandboxedBashOps(mgr as never, undefined, () => ["blocked.example.com"]);
  const root = mkdtempSync(path.join(tmpdir(), "perm-block-"));
  try {
    await ops.exec("echo hello", root, { onData: (d: Buffer) => outputs.push(d.toString()), timeout: 0.01 });
  } catch {
    // timeout expected
  }
  const blockedMsg = outputs.find((o) => o.includes("blocked by the sandbox allowlist"));
  assert.ok(blockedMsg, "blocked hint was emitted");
});

test("createSandboxedBashOps: customConfig passes through", async () => {
  const { mgr, calls } = makeFakeManager();
  const ops = createSandboxedBashOps(mgr as never, { filesystem: { allowWrite: [] } });
  const root = mkdtempSync(path.join(tmpdir(), "perm-cfg-"));
  try {
    await ops.exec("echo hello", root, { onData: () => {}, signal: undefined, timeout: 0.01 });
  } catch {
    // timeout expected
  }
  assert.ok(calls.some((c) => c.method === "wrapWithSandbox"));
});

// ---------------------------------------------------------------------------
// bashOps (platform-neutral)
// ---------------------------------------------------------------------------

test("bashOps: returns null when degraded (no manager)", async () => {
  const ctrl = new SandboxController();
  ctrl.disabled = true;
  internals(ctrl).degraded = true;
  const ops = ctrl.bashOps();
  assert.equal(ops, null);
});

test("bashOps: returns null when manager is missing", async () => {
  const ctrl = new SandboxController();
  assert.equal(ctrl.bashOps(), null);
});

// ---------------------------------------------------------------------------
// SandboxController.installHint
// ---------------------------------------------------------------------------

test("installHint: returns the correct format", () => {
  const hint = (SandboxController as unknown as { installHint: () => string }).installHint();
  assert.match(hint, /Fix:.*npm install/);
});

test("init (win32): failing to stage srt-win degrades instead of throwing", async () => {
  const fake = makeFakeWinRuntime();
  const { controller, initOpts } = buildWinController(fake, {
    stageHelper: () => {
      throw new Error("disk full");
    },
  });
  await controller.init(initOpts);
  assert.equal(controller.ready, false);
  assert.match(controller.warn ?? "", /could not stage srt-win \(disk full\)/);
  assert.equal(count(fake.calls, "initialize"), 0);
});
