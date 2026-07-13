import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('lock', () => {
  let tmpDir: string;
  const g = global as any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'slk-bridge-lock-'));
    delete g.__msgBridgeInstanceId;
    delete g.__msgBridgeConnected;
    delete g.__msgBridgeOwner;
    vi.resetModules();
  });

  afterEach(() => {
    delete g.__msgBridgeConnected;
    delete g.__msgBridgeOwner;
    delete g.__msgBridgeInstanceId;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importLock(lockDir: string) {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => lockDir };
    });
    return await import('../../src/session/lock');
  }

  it('acquires lock and writes lock file', async () => {
    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
    expect(g.__msgBridgeConnected).toBe(true);

    const lockPath = join(tmpDir, '.pi', 'slk-bridge.lock');
    const content = readFileSync(lockPath, 'utf-8');
    const [pid, owner] = content.split(':');
    expect(parseInt(pid, 10)).toBe(process.pid);
    expect(owner).toBe(g.__msgBridgeInstanceId);
  });

  it('allows same instance to re-acquire (idempotent)', async () => {
    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
    expect(acquireLock()).toBe(true);
  });

  it('release clears global state and removes lock file', async () => {
    const { acquireLock, releaseLock } = await importLock(tmpDir);
    acquireLock();

    releaseLock();
    expect(g.__msgBridgeConnected).toBe(false);
    expect(g.__msgBridgeOwner).toBeUndefined();
    expect(existsSync(join(tmpDir, '.pi', 'slk-bridge.lock'))).toBe(false);
  });

  it('acquire → release → re-acquire works', async () => {
    const { acquireLock, releaseLock } = await importLock(tmpDir);

    expect(acquireLock()).toBe(true);
    releaseLock();
    expect(g.__msgBridgeConnected).toBe(false);

    expect(acquireLock()).toBe(true);
    expect(g.__msgBridgeConnected).toBe(true);
    expect(existsSync(join(tmpDir, '.pi', 'slk-bridge.lock'))).toBe(true);
  });

  it('blocks a different instance in the same process (layer 1)', async () => {
    const { acquireLock } = await importLock(tmpDir);
    acquireLock();

    vi.resetModules();
    delete g.__msgBridgeInstanceId;
    const lock2 = await importLock(tmpDir);

    expect(lock2.acquireLock()).toBe(false);
  });

  it('overwrites stale lock from dead process (layer 2)', async () => {
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'slk-bridge.lock'), '1073741824:stale-owner');

    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
  });

  it('blocks when a live process holds the lock (layer 2)', async () => {
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'slk-bridge.lock'), `${process.pid}:other-instance`);

    const { acquireLock } = await importLock(tmpDir);
    expect(acquireLock()).toBe(false);
  });

  it('releaseLock is a no-op for non-owner', async () => {
    const { acquireLock, releaseLock } = await importLock(tmpDir);
    acquireLock();

    const realOwner = g.__msgBridgeOwner;
    g.__msgBridgeOwner = 'someone-else';
    releaseLock();

    g.__msgBridgeOwner = realOwner;
    expect(g.__msgBridgeConnected).toBe(true);
    expect(existsSync(join(tmpDir, '.pi', 'slk-bridge.lock'))).toBe(true);
  });

  it('creates .pi directory if missing', async () => {
    const { acquireLock } = await importLock(tmpDir);
    expect(existsSync(join(tmpDir, '.pi'))).toBe(false);

    acquireLock();
    expect(existsSync(join(tmpDir, '.pi'))).toBe(true);
  });

  it('forceAcquireLock overwrites another owner', async () => {
    const piDir = join(tmpDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'slk-bridge.lock'), `${process.pid}:other-instance`);

    const { forceAcquireLock } = await importLock(tmpDir);
    const previousOwner = forceAcquireLock();

    expect(previousOwner).toEqual({ pid: process.pid, owner: 'other-instance' });
    expect(readFileSync(join(piDir, 'slk-bridge.lock'), 'utf-8')).toBe(`${process.pid}:${g.__msgBridgeInstanceId}`);
    expect(g.__msgBridgeConnected).toBe(true);
    expect(g.__msgBridgeOwner).toBe(g.__msgBridgeInstanceId);
  });

  it('reports whether lock is held locally and currently owned', async () => {
    const { acquireLock, isCurrentLockOwner, isLockHeldLocally } = await importLock(tmpDir);

    expect(isLockHeldLocally()).toBe(false);
    expect(isCurrentLockOwner()).toBe(false);

    acquireLock();
    expect(isLockHeldLocally()).toBe(true);
    expect(isCurrentLockOwner()).toBe(true);
  });

  it('detects when local ownership has been stolen', async () => {
    const { acquireLock, getInstanceId, isCurrentLockOwner, isLockHeldLocally } = await importLock(tmpDir);
    expect(acquireLock()).toBe(true);
    expect(isCurrentLockOwner()).toBe(true);

    writeFileSync(
      join(tmpDir, '.pi', 'slk-bridge.lock'),
      `${process.pid}:someone-else`,
    );

    expect(getInstanceId()).toBe(g.__msgBridgeInstanceId);
    expect(isLockHeldLocally()).toBe(true);
    expect(isCurrentLockOwner()).toBe(false);
  });
});
