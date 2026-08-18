import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fail-fast guard for Socket Mode connect.
 *
 * The underlying @slack/socket-mode client retries `apps.connections.open`
 * with exponential backoff (retries: 100, factor: 1.3, maxTimeout: Infinity),
 * so an unreachable Slack can otherwise block connect() — and anything that
 * awaits it (e.g. the extension's session_start) — for a very long time.
 * These tests verify connect() rejects with a timeout instead of hanging.
 */

// Minimal ChallengeAuth stub — the client only stores it, never calls it in connect().
const stubAuth = {} as any;

// A fake @slack/bolt App whose start() never resolves (simulates an unreachable
// Slack socket). stop() resolves so abortPartialConnect can tear down cleanly.
class HangingApp {
  client = { auth: { test: async () => ({ user_id: 'U123' }) } };
  message() {}
  error() {}
  start() {
    return new Promise(() => {}); // never settles
  }
  async stop() {}
}

// A working App whose start() resolves immediately.
class WorkingApp {
  client = { auth: { test: async () => ({ user_id: 'U123' }) } };
  message() {}
  error() {}
  async start() {}
  async stop() {}
}

let boltMock: any;
let useHangingApp = true;

// A constructor that can be invoked with `new` (as the client does: new App(...))
// and that returns an app instance based on the current mode.
class MockApp {
  constructor() {
    return useHangingApp ? new HangingApp() : new WorkingApp();
  }
}

beforeEach(() => {
  useHangingApp = true;
  boltMock = {
    App: MockApp,
    LogLevel: { ERROR: 0 },
  };
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

async function importClient() {
  vi.doMock('@slack/bolt', () => boltMock);
  return await import('../../src/slack/client');
}

describe('SlackClient.connect timeout', () => {
  it('rejects with a timeout when the socket connect hangs', async () => {
    const { SlackClient } = await importClient();
    const client = new SlackClient(
      { botToken: 'xoxb-test', appToken: 'xapp-test' },
      stubAuth,
      50, // tiny timeout for a fast test
    );

    await expect(client.connect()).rejects.toThrow('Slack connection timed out');
    expect(client.isConnected).toBe(false);
  });

  it('resolves normally when the socket connects within the timeout', async () => {
    useHangingApp = false;
    const { SlackClient } = await importClient();
    const client = new SlackClient(
      { botToken: 'xoxb-test', appToken: 'xapp-test' },
      stubAuth,
      500,
    );

    await expect(client.connect()).resolves.toBeUndefined();
    expect(client.isConnected).toBe(true);
  });

  it('can reconnect after a timeout (partial state is torn down)', async () => {
    const { SlackClient } = await importClient();
    const client = new SlackClient(
      { botToken: 'xoxb-test', appToken: 'xapp-test' },
      stubAuth,
      50,
    );

    await expect(client.connect()).rejects.toThrow('Slack connection timed out');

    // Now the socket "comes back" — a fresh connect should succeed.
    useHangingApp = false;
    await expect(client.connect()).resolves.toBeUndefined();
    expect(client.isConnected).toBe(true);
  });
});
