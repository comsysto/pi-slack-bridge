import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Single-instance connection guard.
 *
 * Two layers:
 *  1. global flag  — catches same-process re-entrant calls (e.g. sub-agents
 *                    spawned inside the same Node.js process, same PID).
 *  2. PID lock file — catches separate-process duplicates (e.g. sub-agents
 *                    launched as child processes with different PIDs).
 *
 * Manual connect can also force ownership transfer by overwriting the shared
 * owner record. Older sessions notice they are no longer the owner and
 * disconnect themselves on their next ownership check.
 */

const CONFIG_DIR = path.join(os.homedir(), ".pi");
const LOCK_PATH = path.join(CONFIG_DIR, "slk-bridge.lock");
const LEGACY_LOCK_PATH = path.join(CONFIG_DIR, "msg-bridge.lock");

const g = global as any;
if (!g.__msgBridgeInstanceId) {
  g.__msgBridgeInstanceId = Math.random().toString(36).slice(2);
}
const instanceId: string = g.__msgBridgeInstanceId;

interface LockInfo {
  pid: number;
  owner: string;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function parseLockInfo(raw: string): LockInfo | null {
  const [pidStr, owner = ""] = raw.trim().split(":");
  const pid = parseInt(pidStr, 10);
  if (Number.isNaN(pid) || !owner) return null;
  return { pid, owner };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getInstanceId(): string {
  return instanceId;
}

export function getLockOwner(): LockInfo | null {
  try {
    const lockPath = resolveLockPath();
    if (!fs.existsSync(lockPath)) return null;
    const raw = fs.readFileSync(lockPath, "utf-8");
    const info = parseLockInfo(raw);
    if (!info) return null;
    if (info.pid !== process.pid && !isProcessAlive(info.pid)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore stale cleanup failures
      }
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

/** For writing, always use the new path. For reading, prefer new but fall back to legacy. */
function resolveLockPath(forWrite: boolean = false): string {
  if (forWrite) return LOCK_PATH;
  return fs.existsSync(LOCK_PATH) ? LOCK_PATH : LEGACY_LOCK_PATH;
}

export function isLockHeldLocally(): boolean {
  return g.__msgBridgeConnected === true && g.__msgBridgeOwner === instanceId;
}

export function isCurrentLockOwner(): boolean {
  if (!isLockHeldLocally()) return false;
  const info = getLockOwner();
  return !!info && info.pid === process.pid && info.owner === instanceId;
}

export function acquireLock(): boolean {
  // Layer 1: same-process guard via a global flag
  if (g.__msgBridgeConnected && g.__msgBridgeOwner !== instanceId) {
    return false;
  }

  // Layer 2: cross-process guard via PID lock file
  try {
    const currentOwner = getLockOwner();
    if (currentOwner) {
      if (currentOwner.pid === process.pid && currentOwner.owner !== instanceId) {
        return false;
      }
      if (currentOwner.pid !== process.pid || currentOwner.owner !== instanceId) {
        return false;
      }
    }

    ensureConfigDir();
    fs.writeFileSync(resolveLockPath(true), `${process.pid}:${instanceId}`, { mode: 0o600 });
  } catch {
    // lock file mechanics failed — fall through, global flag is still set below
  }

  g.__msgBridgeConnected = true;
  g.__msgBridgeOwner = instanceId;
  return true;
}

export function forceAcquireLock(): LockInfo | null {
  const previousOwner = getLockOwner();

  try {
    ensureConfigDir();
    fs.writeFileSync(resolveLockPath(true), `${process.pid}:${instanceId}`, { mode: 0o600 });
  } catch {
    // ignore lock file failures; local ownership state is still updated below
  }

  g.__msgBridgeConnected = true;
  g.__msgBridgeOwner = instanceId;
  return previousOwner;
}

export function releaseLock(): void {
  if (g.__msgBridgeOwner !== instanceId) return;
  g.__msgBridgeConnected = false;
  g.__msgBridgeOwner = undefined;
  try {
    // Always read from the path that exists (new or legacy), but only unlink the new path
    // since that's where we always write.
    const existingLockPath = resolveLockPath(false);
    if (fs.existsSync(existingLockPath)) {
      const raw = fs.readFileSync(existingLockPath, "utf-8");
      const info = parseLockInfo(raw);
      if (info && info.pid === process.pid && info.owner === instanceId) {
        fs.unlinkSync(LOCK_PATH);
      }
    }
  } catch {
    // ignore
  }
}
