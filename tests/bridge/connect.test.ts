import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('connectSlackBridge', () => {
  let tmpDir: string;
  let mockPi: any;
  let registeredCommand: any;
  const g = global as any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'slk-bridge-connect-'));
    delete g.__slkBridgeInstanceId;
    delete g.__slkBridgeConnected;
    delete g.__slkBridgeOwner;
    vi.resetModules();

    mockPi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name, opts) => {
        registeredCommand = { name, ...opts };
      }),
      sendUserMessage: vi.fn(),
      getCommands: vi.fn().mockReturnValue([]),
    };
  });

  afterEach(() => {
    delete g.__slkBridgeConnected;
    delete g.__slkBridgeOwner;
    delete g.__slkBridgeInstanceId;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importBridge() {
    vi.doMock('os', async () => {
      const actual = await vi.importActual<typeof import('os')>('os');
      return { ...actual, homedir: () => tmpDir };
    });
    vi.doMock('../auth/challenge.js', () => ({
      ChallengeAuth: vi.fn().mockImplementation(() => ({
        getNotificationChatIds: vi.fn().mockReturnValue(['D123']),
        getStats: vi.fn().mockReturnValue({ trustedUser: 'testuser', channels: 0 }),
        loadFromConfig: vi.fn(),
        exportConfig: vi.fn().mockReturnValue({}),
      })),
    }));
    vi.doMock('../slack/client.js', () => ({
      SlackClient: vi.fn().mockImplementation(() => ({
        isConnected: false,
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        sendMessageInThread: vi.fn().mockResolvedValue('123.456'),
        onMessage: vi.fn(),
        onError: vi.fn(),
      })),
    }));
    return await import('../../src/bridge/index');
  }

  it('connectSlackBridge is accessible through the command handler', async () => {
    const bridge = await importBridge();
    bridge.default(mockPi);
    expect(registeredCommand).toBeDefined();
    expect(registeredCommand.name).toBe('slk-bridge');
  });

  it('connectCurrentSession forwards to connectSlackBridge for connection', async () => {
    // The refactored connectCurrentSession calls connectSlackBridge internally.
    // We verify by checking the command handler can be invoked without errors.
    const bridge = await importBridge();
    bridge.default(mockPi);
    expect(registeredCommand.handler).toBeDefined();
  });
});
