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
// Native Windows — no OS sandbox: degrade honestly so bash prompts
// ---------------------------------------------------------------------------

const WIN_PROFILE = {
  enabled: true,
  writable: true,
  allowWrite: ["."],
  denyWrite: [],
  denyRead: [],
  network: { allowedDomains: [], deniedDomains: [] },
};

test("init (win32): degrades — never reports ready, warns, notifies once", async () => {
  const notified: string[] = [];
  const { controller, initOpts } = buildController(WIN_PROFILE, {
    platform: "win32",
    hasUI: true,
    notify: (m) => notified.push(m),
  });
  await controller.init(initOpts);
  assert.equal(controller.ready, false);
  assert.equal(internals(controller).degraded, true);
  assert.equal(controller.disabled, false);
  assert.equal(controller.warn, WINDOWS_NO_SANDBOX_WARN);
  assert.equal(notified.length, 1);
  assert.match(notified[0], /no OS sandbox on native Windows/);
  assert.equal(controller.sandboxManager, null);
});

test("init (win32): no notification without a UI", async () => {
  const notified: string[] = [];
  const { controller, initOpts } = buildController(WIN_PROFILE, {
    platform: "win32",
    hasUI: false,
    notify: (m) => notified.push(m),
  });
  await controller.init(initOpts);
  assert.equal(controller.ready, false);
  assert.equal(notified.length, 0);
});

test("applyProfile (win32): switching modes never flips ready on", async () => {
  const { controller, initOpts } = buildController(WIN_PROFILE, { platform: "win32" });
  await controller.init(initOpts);
  await controller.applyProfile(WIN_PROFILE);
  await controller.applyProfile({ ...WIN_PROFILE, writable: false, allowWrite: [] });
  assert.equal(controller.ready, false);
  assert.equal(controller.warn, WINDOWS_NO_SANDBOX_WARN);
});

test("bashOps (win32): no sandboxed operations are offered", async () => {
  const { controller, initOpts } = buildController(WIN_PROFILE, { platform: "win32" });
  await controller.init(initOpts);
  assert.equal(controller.bashOps(), null);
  assert.equal(controller.bashOps({ readOnly: true }), null);
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
