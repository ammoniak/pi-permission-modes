/**
 * OS-level sandbox lifecycle for Build mode.
 *
 * Wraps `@anthropic-ai/sandbox-runtime` (loaded lazily so a missing dependency
 * degrades gracefully instead of crashing) behind a small `SandboxController`
 * that owns init / wrap / reset and the readiness state surfaced in the footer.
 *
 * Native Windows uses the runtime's `srt-win` backend (a dedicated
 * `srt-sandbox` user) once it is installed (`/sandbox install`) and a
 * self-check inside the sandbox passes (see sandbox-win.ts). Otherwise the
 * controller degrades (ready=false) so the sandboxed modes prompt before every
 * bash command instead of claiming a protection that doesn't exist.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { type SandboxConfig, profileToConfig, readOnlyOverride } from "./config-load.ts";
import { gitFileBlocksSandbox, removeSandboxPlaceholders } from "./paths.ts";
import {
  dropRedundantProfileDenies,
  findGitBash,
  gitIdentityPrefix,
  parseProbe,
  probeAdvice,
  probeProblem,
  probeScript,
  probeTargets,
  readGitIdentity,
  stageSrtWin,
} from "./sandbox-win.ts";
import type { SandboxProfile } from "./schema.ts";
import { isModuleNotFound, superviseChild } from "./util.ts";

// Real types of the runtime, erased at compile time so a missing dependency
// never breaks loading.
export type SandboxRuntime = typeof import("@anthropic-ai/sandbox-runtime");
type SandboxManagerType = SandboxRuntime["SandboxManager"];

/** This extension's own directory (works wherever it's installed). */
const EXTENSION_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * Any network denial during a run (allowlist miss the user didn't approve) is
 * recorded by the ask callback; surface it to the model after the run so a
 * refused connection is diagnosable, not mystery.
 */
function blockedHostsReporter(drainBlockedHosts: (() => string[]) | undefined, onData: (data: Buffer) => void) {
  return () => {
    const hosts = drainBlockedHosts?.() ?? [];
    if (hosts.length > 0) {
      onData(
        Buffer.from(
          `\n[permission-mode] network: connection(s) blocked by the sandbox allowlist: ${hosts.join(", ")}. ` +
            "Request access with the request_network_access tool, or ask the user (/net allow <domain>).\n",
        ),
      );
    }
  };
}

/**
 * BashOperations backed by `SandboxManager.wrapWithSandbox`. An optional
 * `customConfig` overrides the init-time config per command (used to drop write
 * access in Read mode without re-initializing the sandbox).
 */
export function createSandboxedBashOps(
  SandboxManager: SandboxManagerType,
  customConfig?: Partial<SandboxConfig>,
  drainBlockedHosts?: () => string[],
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      const emitBlockedHint = blockedHostsReporter(drainBlockedHosts, onData);
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      drainBlockedHosts?.(); // discard denials that belong to earlier runs
      // Clear any leftover 0-byte placeholders the sandbox plants for its
      // mandatory-deny paths (a stale .git would also break this run).
      removeSandboxPlaceholders(cwd);
      try {
        const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, customConfig as never);
        const child = spawn("bash", ["-c", wrapped], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        const kill = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        // `await` so the finally runs after the child exits, not after the
        // Promise is constructed — otherwise cleanup would race the run.
        return await superviseChild(child, kill, { onData, signal, timeout }, emitBlockedHint);
      } finally {
        // Always delete the placeholders bwrap just planted, regardless of how
        // we leave: normal close, abort/timeout rejection, a throw from
        // wrapWithSandbox, or a synchronous spawn failure.
        removeSandboxPlaceholders(cwd);
      }
    },
  };
}

/**
 * BashOperations for the native Windows backend: `srt-win exec` runs Git Bash
 * as the `srt-sandbox` user. The argv is spawned directly (never through a
 * host shell), and killing `srt-win` tears down the sandboxed tree via its
 * kill-on-close job. The sandbox user has no global gitconfig, so the host's
 * git identity rides along as an `export` prefix.
 */
export function createWindowsSandboxedBashOps(
  SandboxManager: SandboxManagerType,
  bashExe: string,
  commandPrefix: string,
  drainBlockedHosts?: () => string[],
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      const emitBlockedHint = blockedHostsReporter(drainBlockedHosts, onData);
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
      drainBlockedHosts?.(); // discard denials that belong to earlier runs
      const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
        commandPrefix + command,
        { exe: bashExe, args: ["-c"] },
        undefined,
        signal,
        cwd,
      );
      const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      return superviseChild(child, () => child.kill(), { onData, signal, timeout }, emitBlockedHint);
    },
  };
}

/** How the caller surfaces warnings (e.g. a TUI notify), only used when there's a UI. */
type Notify = (message: string) => void;

export interface InitOptions {
  cwd: string;
  noSandbox: boolean;
  hasUI: boolean;
  notify: Notify;
  /** The active mode's sandbox profile to initialize the runtime with. */
  profile: SandboxProfile;
  /**
   * Live network ask: called by the runtime's proxy for a host no allow/deny
   * rule matches, WHILE the connection waits. Return true to allow. Undefined
   * keeps the historic silent-deny behavior.
   */
  askHost?: (host: string, port: number | undefined) => Promise<boolean>;
  /** Drained by the bash wrapper to report hosts blocked during a run. */
  drainBlockedHosts?: () => string[];
  /** Host platform (injected in tests); defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Config `windowsSandbox`: false keeps native Windows on prompting. */
  windowsSandbox?: boolean;
  /** Loads the runtime module (injected in tests). */
  loadRuntime?: () => Promise<SandboxRuntime>;
  /** Locates Git Bash on Windows (injected in tests). */
  findBash?: () => string | undefined;
  /** Copies `srt-win.exe` somewhere the sandbox user can launch it; returns the path (injected in tests). */
  stageHelper?: (bundledExe: string) => string;
}

/** Why the sandboxed modes prompt on native Windows when the backend is switched off (footer + awareness). */
export const WINDOWS_NO_SANDBOX_WARN = "no OS sandbox on native Windows — bash asks first";
/** The Windows backend isn't provisioned on this machine yet. */
export const WINDOWS_NOT_INSTALLED_WARN = "Windows sandbox not installed — /sandbox install";

/** Windows backend state, present while the runtime drives `srt-win`. */
interface WindowsBackend {
  bash: string;
  srtWinPath: string;
  /** `export` prefix carrying the host git identity. */
  commandPrefix: string;
  /** The in-sandbox self-check already passed for this init. */
  probed: boolean;
}

/**
 * Owns the sandbox runtime and its readiness state. A single instance lives for
 * the extension's lifetime; `init` is re-runnable across sessions, and
 * `applyProfile` re-initializes when the active mode's sandbox profile changes.
 */
export class SandboxController {
  private manager: SandboxManagerType | null = null;
  private profile: SandboxProfile | undefined;
  /** Key of the profile the runtime is currently initialized with. */
  private appliedKey: string | undefined;
  /** Platform/dependency/git issue — never (re)initialize the runtime. */
  private degraded = false;
  private hasUI = false;
  private notifyFn: Notify = () => {};
  private askHost: ((host: string, port: number | undefined) => Promise<boolean>) | undefined;
  private drainBlockedHosts: (() => string[]) | undefined;
  /** Options of the last `init`, so `/sandbox install` can re-run it. */
  private lastInit: InitOptions | undefined;
  private cwd = "";
  private win: WindowsBackend | undefined;
  /** Whether the Windows runtime was initialized with project writes (read-only is session-wide there). */
  private appliedWritable = true;
  ready = false;
  disabled = false;
  warn: string | undefined;

  /** The active runtime, or null when unavailable. */
  get sandboxManager(): SandboxManagerType | null {
    return this.manager;
  }

  /**
   * Wrap a fresh BashOperations around the active runtime, or null when
   * unavailable.
   *
   * With `readOnly`, the command runs with project writes disabled
   * (Plan mode) — the library still allows its own default scratch paths.
   * On Windows, per-command write overrides are unsupported (the runtime
   * throws), so read-only is applied when the session initializes and a
   * mismatch here returns null (the caller then refuses to run).
   */
  bashOps(opts: { readOnly?: boolean } = {}): BashOperations | null {
    if (!this.manager || !this.profile) return null;
    if (this.win) {
      if (!!opts.readOnly === this.appliedWritable) return null;
      return createWindowsSandboxedBashOps(this.manager, this.win.bash, this.win.commandPrefix, this.drainBlockedHosts);
    }
    const customConfig = opts.readOnly ? readOnlyOverride(profileToConfig(this.profile)) : undefined;
    return createSandboxedBashOps(this.manager, customConfig, this.drainBlockedHosts);
  }

  /** Install instructions shown when the runtime is missing or fails to init. */
  private static installHint(): string {
    const linux = process.platform === "linux" ? "  (Linux also needs: bubblewrap, socat, ripgrep)" : "";
    return `Fix: cd ${EXTENSION_DIR} && npm install${linux}`;
  }

  async init(opts: InitOptions): Promise<void> {
    const {
      cwd,
      noSandbox,
      hasUI,
      notify,
      profile,
      askHost,
      drainBlockedHosts,
      platform = process.platform,
      loadRuntime = () => import("@anthropic-ai/sandbox-runtime"),
    } = opts;
    this.ready = false;
    this.disabled = false;
    this.degraded = false;
    this.warn = undefined;
    this.manager = null;
    this.win = undefined;
    this.appliedKey = undefined;
    this.hasUI = hasUI;
    this.notifyFn = notify;
    this.askHost = askHost;
    this.drainBlockedHosts = drainBlockedHosts;
    this.lastInit = opts;
    this.cwd = cwd;

    if (noSandbox) {
      this.disabled = true;
      this.degraded = true;
      this.profile = profile;
      return;
    }
    if (platform === "win32") return this.initWindows(opts, loadRuntime);
    if (platform !== "darwin" && platform !== "linux") {
      this.warn = `sandbox unsupported on ${platform}`;
      this.degraded = true;
      this.profile = profile;
      return;
    }

    try {
      this.manager = (await loadRuntime()).SandboxManager;
    } catch (err) {
      this.degraded = true;
      this.profile = profile;
      this.warn = isModuleNotFound(err)
        ? "sandbox-runtime missing (run npm install in the extension dir)"
        : `sandbox load failed: ${err instanceof Error ? err.message : String(err)}`;
      if (hasUI) {
        notify(
          `permission-mode: OS sandbox unavailable — protection is heuristic-only.\n${this.warn}\n` +
            SandboxController.installHint(),
        );
      }
      return;
    }

    // Clear any 0-byte placeholders left by a prior sandboxed run (incl. a stale
    // .git), so .git below isn't mistaken for a worktree.
    removeSandboxPlaceholders(cwd);

    // bubblewrap unconditionally binds <cwd>/.git/hooks; if .git is a REAL file
    // (git worktree/submodule) that bind fails and every sandboxed command
    // errors — and we must not delete that legitimate file. Degrade to prompting.
    if (gitFileBlocksSandbox(cwd)) {
      this.degraded = true;
      this.profile = profile;
      this.warn = "sandbox off: project .git is a file (worktree/submodule); bwrap can't bind .git/hooks";
      if (hasUI) {
        notify(
          "permission-mode: OS sandbox disabled for this project — its `.git` is a file (git worktree/submodule), " +
            "which bubblewrap can't sandbox. In-project bash will prompt for confirmation instead. " +
            "Use a normal clone for full sandboxing.",
        );
      }
      return; // leave ready=false → the sandboxed modes degrade to prompting
    }

    await this.applyProfile(profile);
  }

  /** Stop trying to sandbox for this init: record why, and tell the user once. */
  private degrade(profile: SandboxProfile, warn: string, message?: string): void {
    this.degraded = true;
    this.profile = profile;
    this.warn = warn;
    if (message && this.hasUI) this.notifyFn(message);
  }

  /**
   * Native Windows: use the runtime's `srt-win` backend when it's provisioned
   * and Git Bash is installed machine-wide. The in-sandbox self-check runs on
   * the first real initialize (see applyProfile).
   */
  private async initWindows(opts: InitOptions, loadRuntime: () => Promise<SandboxRuntime>): Promise<void> {
    const { profile, cwd } = opts;
    if (opts.windowsSandbox !== true) {
      return this.degrade(
        profile,
        WINDOWS_NO_SANDBOX_WARN,
        "permission-mode: no OS sandbox on native Windows — the sandboxed modes ask before every bash command " +
          "(approvals can be remembered per command). For real isolation run pi under WSL2, or try the experimental " +
          'native sandbox: set "windowsSandbox": true in the global config (see README → Windows).',
      );
    }
    let rt: SandboxRuntime;
    try {
      rt = await loadRuntime();
    } catch (err) {
      return this.degrade(
        profile,
        isModuleNotFound(err) ? "sandbox-runtime missing (run npm install in the extension dir)" : `sandbox load failed: ${String(err)}`,
      );
    }
    try {
      const status = await rt.checkWindowsSandboxStatusAsync({ srtWin: rt.resolveSrtWin({ path: rt.VENDORED_SRT_WIN_EXE }) });
      if (!status.user.provisioned) {
        return this.degrade(
          profile,
          WINDOWS_NOT_INSTALLED_WARN,
          "permission-mode: the Windows sandbox isn't installed — the sandboxed modes ask before every bash command. " +
            "Run /sandbox install (one UAC prompt; creates a local `srt-sandbox` user and firewall filters).",
        );
      }
    } catch (err) {
      return this.degrade(profile, `Windows sandbox check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const bash = (opts.findBash ?? findGitBash)();
    if (!bash) {
      return this.degrade(
        profile,
        "Windows sandbox off: Git Bash not found",
        "permission-mode: the Windows sandbox runs commands in Git Bash, installed machine-wide (Program Files). " +
          "None was found, so the sandboxed modes ask before every bash command.",
      );
    }
    let srtWinPath: string;
    try {
      srtWinPath = (opts.stageHelper ?? stageSrtWin)(rt.VENDORED_SRT_WIN_EXE);
    } catch (err) {
      return this.degrade(profile, `Windows sandbox off: could not stage srt-win (${err instanceof Error ? err.message : String(err)})`);
    }
    const id = readGitIdentity(cwd);
    this.manager = rt.SandboxManager;
    this.win = { bash, srtWinPath, commandPrefix: gitIdentityPrefix(id.name, id.email), probed: false };
    await this.applyProfile(profile);
  }

  /**
   * Run the self-check inside the freshly initialized Windows sandbox. Returns
   * true when it passed; otherwise tears the runtime down and degrades.
   */
  private async probeWindows(win: WindowsBackend, manager: SandboxManagerType, profile: SandboxProfile): Promise<boolean> {
    let out = "";
    try {
      const ops = createWindowsSandboxedBashOps(manager, win.bash, "");
      const script = probeScript(this.cwd, probeTargets(this.cwd, win.srtWinPath), randomBytes(6).toString("hex"));
      await ops.exec(script, this.cwd, { onData: (d) => (out += d.toString()), timeout: 120 });
    } catch (err) {
      out += `\n${err instanceof Error ? err.message : String(err)}`;
    }
    const result = parseProbe(out);
    const problem = probeProblem(result);
    if (!problem) {
      win.probed = true;
      return true;
    }
    this.ready = false;
    try {
      await manager.reset();
    } catch {
      // ignore cleanup errors
    }
    // Drop the runtime so nothing can hand out operations for a sandbox we rejected.
    this.manager = null;
    this.win = undefined;
    this.degrade(profile, problem, `permission-mode: ${probeAdvice(result)}`);
    return false;
  }

  /**
   * Install or remove the Windows backend (one UAC prompt each), then re-run
   * the last init so the result takes effect immediately. Returns a status line.
   */
  async windowsSetup(action: "install" | "uninstall"): Promise<string> {
    const loadRuntime = this.lastInit?.loadRuntime ?? (() => import("@anthropic-ai/sandbox-runtime"));
    const rt = await loadRuntime();
    const srtWin = rt.resolveSrtWin({ path: rt.VENDORED_SRT_WIN_EXE });
    if (action === "install") {
      const r = await rt.installWindowsSandboxAsync({ srtWin });
      if (r.cancelled) return "Windows sandbox install cancelled (UAC prompt dismissed).";
    } else {
      await this.reset(); // drop this session's ACEs before the account goes away
      const r = rt.uninstallWindowsSandbox({ srtWin });
      if (r.cancelled) return "Windows sandbox uninstall cancelled (UAC prompt dismissed).";
    }
    if (this.lastInit) await this.init(this.lastInit);
    if (this.ready) return "Windows sandbox installed and active.";
    return action === "install"
      ? `Windows sandbox installed, but not active: ${this.warn ?? "unknown"}`
      : "Windows sandbox removed — the sandboxed modes ask before every bash command.";
  }

  /**
   * Ensure the runtime is initialized with `profile`. A no-op when degraded, when
   * the profile doesn't sandbox (`enabled:false`), or when the profile's
   * filesystem/network is unchanged. Re-initializes (reset + initialize) when the
   * profile differs, so switching to a mode with different folders/network takes
   * effect immediately.
   */
  async applyProfile(profile: SandboxProfile): Promise<void> {
    this.profile = profile;
    if (this.degraded) return;

    if (!this.manager) return;
    if (!profile.enabled) return; // non-sandboxing mode (e.g. YOLO): keep prior init

    const win = this.win;
    let cfg = profileToConfig(profile);
    // Windows can't drop writes per command, so a read-only mode (Plan)
    // initializes the whole session without project writes.
    if (win && !profile.writable) cfg = { ...cfg, ...readOnlyOverride(cfg) } as SandboxConfig;
    if (win && cfg.filesystem) {
      const { allowWrite, denyRead, denyWrite } = cfg.filesystem;
      const home = process.env.USERPROFILE;
      cfg = {
        ...cfg,
        filesystem: {
          ...cfg.filesystem,
          denyRead: dropRedundantProfileDenies(denyRead, allowWrite, home, this.cwd),
          denyWrite: dropRedundantProfileDenies(denyWrite, allowWrite, home, this.cwd),
        },
      };
    }
    const key = JSON.stringify({ n: cfg.network, f: cfg.filesystem });
    if (this.ready && key === this.appliedKey) return;

    try {
      if (this.ready) await this.manager.reset();
      // The ask callback rides along so unmatched hosts prompt instead of
      // silently failing; it reads live session state, so grants/`/net open`
      // apply instantly without re-initializing.
      const ask = this.askHost;
      await this.manager.initialize(
        {
          network: cfg.network,
          filesystem: cfg.filesystem,
          ...(win ? { windows: { srtWin: { path: win.srtWinPath } } } : {}),
        } as never,
        ask ? (p: { host: string; port?: number }) => ask(p.host, p.port) : undefined,
      );
      if (win && !win.probed && !(await this.probeWindows(win, this.manager, profile))) return;
      this.ready = true;
      this.appliedKey = key;
      this.appliedWritable = profile.writable;
      this.warn = undefined;
    } catch (err) {
      this.ready = false;
      this.warn = `sandbox init failed: ${err instanceof Error ? err.message : String(err)}`;
      if (this.hasUI) {
        this.notifyFn(
          `permission-mode: sandbox failed to initialize — protection is heuristic-only.\n${this.warn}` +
            `${process.platform === "linux" ? "\nLinux requires: bubblewrap, socat, ripgrep" : ""}`,
        );
      }
    }
  }

  async reset(): Promise<void> {
    if (this.ready && this.manager) {
      try {
        await this.manager.reset();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
