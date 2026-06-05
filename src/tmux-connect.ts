import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TmuxConnectOptions {
  cwd: string;
  piBin?: string;
  piArgs?: string[];
  bridgeCommand?: string;
  startupWaitMs?: number;
  postSendWaitMs?: number;
  cleanupDelayMs?: number;
  attachClient?: boolean;
  cleanupOtherSessions?: boolean;
}

export interface TmuxConnectResult {
  sessionName: string;
  cwd: string;
  bridgeCommand: string;
  paneOutput: string;
  cleanupScheduled: boolean;
}

export function resolvePathInput(input: string, baseDir: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  if (path.isAbsolute(input)) return input;
  return path.resolve(baseDir, input);
}

export function buildTmuxConnectSummary(result: TmuxConnectResult): string {
  const lines = [
    "✅ Started a fresh bridge session",
    `Directory: ${result.cwd}`,
    result.cleanupScheduled
      ? "Cleanup: older background sessions will be removed automatically"
      : "Cleanup: not scheduled",
    "",
    "Recent startup output:",
    result.paneOutput.trim() || "(no startup output)",
  ];

  return lines.join("\n");
}

export async function runTmuxPiConnect(options: TmuxConnectOptions): Promise<TmuxConnectResult> {
  const bridgeCommand = options.bridgeCommand || "/msg-bridge connect";
  const startupWaitMs = options.startupWaitMs ?? 2000;
  const postSendWaitMs = options.postSendWaitMs ?? 2000;
  const cleanupDelayMs = options.cleanupDelayMs ?? 3000;
  const piBin = options.piBin || "pi";
  const piArgs = options.piArgs || [];
  const attachClient = options.attachClient ?? true;
  const cleanupOtherSessions = options.cleanupOtherSessions ?? true;

  ensureExecutable("tmux");
  ensureExecutable(piBin);

  const cwd = resolvePathInput(options.cwd, process.cwd());
  if (!fs.existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }
  if (!fs.statSync(cwd).isDirectory()) {
    throw new Error(`Working directory is not a directory: ${cwd}`);
  }

  const sessionName = generateSessionName(cwd);
  const piCommand = [shellQuote(piBin), ...piArgs.map(shellQuote)].join(" ");
  runTmux([
    "new-session",
    "-d",
    "-s",
    sessionName,
    `cd ${shellQuote(cwd)} && exec ${piCommand}`,
  ]);
  await sleep(startupWaitMs);

  if (attachClient) {
    runTmux(["switch-client", "-t", sessionName], { allowFailure: true });
  }
  runTmux(["send-keys", "-t", sessionName, bridgeCommand]);
  await sleep(300);
  runTmux(["send-keys", "-t", sessionName, "Enter"]);
  await sleep(postSendWaitMs);

  const paneOutput = runTmux([
    "capture-pane",
    "-pt",
    `${sessionName}:0.0`,
    "-S",
    "-160",
  ]).stdout.trimEnd();

  if (cleanupOtherSessions) {
    scheduleCleanupOtherSessions(sessionName, cleanupDelayMs);
  }

  return {
    sessionName,
    cwd,
    bridgeCommand,
    paneOutput,
    cleanupScheduled: cleanupOtherSessions,
  };
}

function ensureExecutable(command: string): void {
  const result = spawnSync("bash", ["-lc", `command -v ${shellQuote(command)}`], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`${command} is not installed or not in PATH`);
  }
}

function runTmux(args: string[], options?: { allowFailure?: boolean }): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
  });

  if (!options?.allowFailure && result.status !== 0) {
    const message = (result.stderr || result.stdout || `tmux ${args.join(" ")} failed`).trim();
    throw new Error(message);
  }

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

function generateSessionName(cwd: string): string {
  const base = path.basename(cwd) || "home";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "home";

  return `pi-slack-${slug}-${Date.now().toString(36)}`;
}

function scheduleCleanupOtherSessions(keepSessionName: string, delayMs: number): void {
  const script = `
    sleep ${Math.max(1, Math.ceil(delayMs / 1000))}
    while IFS= read -r session; do
      [ -z "$session" ] && continue
      case "$session" in
        pi-slack-*) ;;
        *) continue ;;
      esac
      [ "$session" = ${shellQuote(keepSessionName)} ] && continue
      tmux kill-session -t "$session" >/dev/null 2>&1 || true
    done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
  `;

  const child = spawn("bash", ["-lc", script], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
