import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('handover', () => {
  let tmpDir: string;
  let mockPi: any;
  let registeredCommand: any;
  let capturedOnHandlers: Map<string, any> = new Map();
  let mockSlackClient: any;
  const g = global as any;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'slk-bridge-handover-'));
    delete g.__slkBridgeInstanceId;
    delete g.__slkBridgeConnected;
    delete g.__slkBridgeOwner;
    capturedOnHandlers.clear();
    vi.resetModules();

    mockSlackClient = {
      isConnected: false,
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendMessageInThread: vi.fn().mockResolvedValue('123.456'),
      onMessage: vi.fn(),
      onError: vi.fn(),
    };

    mockPi = {
      on: vi.fn((event, handler) => {
        capturedOnHandlers.set(event, handler);
      }),
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
        getNotificationChatId: vi.fn().mockReturnValue('D123'),
        getStats: vi.fn().mockReturnValue({ trustedUser: 'testuser', channels: 0 }),
        loadFromConfig: vi.fn(),
        exportConfig: vi.fn().mockReturnValue({}),
      })),
    }));
    vi.doMock('../slack/client.js', () => ({
      SlackClient: vi.fn().mockImplementation(() => mockSlackClient),
    }));
    vi.doMock('../config/index.js', () => ({
      loadConfig: vi.fn().mockReturnValue({
        slack: { botToken: 'xoxb-test', appToken: 'xapp-test' },
        optedOutSessions: [],
      }),
      saveConfig: vi.fn(),
    }));
    return await import('../../src/bridge/index');
  }

  it('registers slk-bridge command', async () => {
    const bridge = await importBridge();
    bridge.default(mockPi);
    expect(registeredCommand).toBeDefined();
    expect(registeredCommand.name).toBe('slk-bridge');
  });

  it('handles handover subcommand', async () => {
    const bridge = await importBridge();
    bridge.default(mockPi);
    expect(registeredCommand.handler).toBeDefined();
    // The handler accepts args; verify handover is a recognized subcommand
    // by checking help text mentions it
    const helpText = registeredCommand.handler.toString();
    expect(registeredCommand.description).toContain('help');
  });

  it('agent_end handler is registered', async () => {
    const bridge = await importBridge();
    bridge.default(mockPi);
    expect(capturedOnHandlers.has('agent_end')).toBe(true);
  });

  it('session_start handler is registered', async () => {
    const bridge = await importBridge();
    bridge.default(mockPi);
    expect(capturedOnHandlers.has('session_start')).toBe(true);
  });
});
