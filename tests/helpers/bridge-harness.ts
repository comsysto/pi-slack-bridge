/**
 * bridge-harness.ts — Behavioral test harness for bridge/index.ts.
 *
 * Drives the extension's lifecycle from the outside:
 *  - captures pi.on handlers
 *  - mocks ExtensionContext, SlackClient, config, auth, lock, tmux, handlers
 *  - exposes the captured client message handler so tests can inject Slack messages
 *  - records every sendMessageInThread call so tests can assert on what was pushed to Slack
 */

import { vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export type BranchEntry = {
  type: string;
  id?: string;
  message?: { role: string; content: any; stopReason?: string };
};

export interface HarnessState {
  branch: BranchEntry[];
  sessionFile: string;
  cwd: string;
  trustedChatId: string;
  /** command-context isIdle (handover idle vs busy) */
  cmdIdle: boolean;
  /** session-context isIdle (message forwarding idle vs followUp) */
  agentIdle: boolean;
  autoConnect: boolean;
  hideToolCalls?: boolean;
  slackRouting?: any;
  optedOutSessions?: string[];
}

export interface SendCall {
  chatId: string;
  text: string;
  threadTs?: string;
  footerText?: string;
}

export interface BridgeHarness {
  pi: any;
  registeredCommand: any;
  capturedOn: Map<string, (event: any, context: any) => Promise<void>>;
  slackClient: any;
  clientOnMessage: (msg: any) => void;
  sendCalls: SendCall[];
  notifyCalls: Array<[string, string]>;
  sessionCtx: any;
  tmpDir: string;
  state: HarnessState;
  /** drive helpers */
  sessionStart(): Promise<void>;
  invokeCommand(args: string, cmdCtx?: any): Promise<void>;
  invokeAgentEnd(event: any): Promise<void>;
  invokeClientMessage(msg: any): Promise<void>;
  sendUserMessages(): any[];
  reset(): void;
}

const g = global as any;

export async function createBridgeHarness(state: HarnessState): Promise<BridgeHarness> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'slk-bridge-harness-'));
  delete g.__slkBridgeInstanceId;
  delete g.__slkBridgeConnected;
  delete g.__slkBridgeOwner;
  vi.resetModules();

  const sendCalls: SendCall[] = [];
  const notifyCalls: Array<[string, string]> = [];
  let clientOnMessage: (msg: any) => void = () => {};
  let createdSlackClient: any = null;
  let deferSends = false;
  const deferredSends: Array<(ts: string) => void> = [];
  const tmuxMock = {
    runTmuxPiConnect: vi.fn().mockResolvedValue({ sessionName: 's', cwd: '', bridgeCommand: '', paneOutput: '', cleanupScheduled: false }),
    resolvePathInput: (input: string, _base: string) => input,
    buildTmuxConnectSummary: vi.fn().mockReturnValue('summary'),
  };

  class MockSlackClient {
    isConnected = true;
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    sendMessageInThread = vi.fn(async (chatId: string, text: string, threadTs?: string, footerText?: string) => {
      sendCalls.push({ chatId, text, threadTs, footerText });
      const ts = threadTs || `ts-${sendCalls.length}`;
      if (deferSends) {
        return new Promise<string>((resolve) => {
          deferredSends.push((resolveTs?: string) => resolve(resolveTs ?? ts));
        });
      }
      return ts;
    });
    onMessage = vi.fn((handler: any) => {
      clientOnMessage = handler;
    });
    onError = vi.fn();
    addReaction = vi.fn().mockResolvedValue(undefined);
    removeReaction = vi.fn().mockResolvedValue(undefined);
    sendFile = vi.fn().mockResolvedValue(undefined);
    constructor() {
      createdSlackClient = this;
    }
  }

  const capturedOn = new Map<string, (event: any, context: any) => Promise<void>>();
  let registeredCommand: any = null;
  const pi = {
    on: vi.fn((event: string, handler: any) => {
      capturedOn.set(event, handler);
    }),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, opts: any) => {
      registeredCommand = { name, ...opts };
    }),
    sendUserMessage: vi.fn(),
    getCommands: vi.fn().mockReturnValue([]),
  };

  // ── Re-implemented conversation helpers so the harness stays self-contained ──
  function extractTextSafe(message: { content?: unknown }): string {
    if (!message?.content) return '';
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return (message.content as any[])
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text ?? '')
        .join('\n');
    }
    return '';
  }
  function toHistory(branch: BranchEntry[]) {
    const entries: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    for (const entry of branch) {
      if (entry.type !== 'message' || !entry.message) continue;
      if (entry.message.role === 'user') {
        const text = extractTextSafe(entry.message).trim();
        if (text) entries.push({ role: 'user', text });
      } else if (entry.message.role === 'assistant') {
        if (entry.message.stopReason && entry.message.stopReason !== 'stop') continue;
        const text = extractTextSafe(entry.message).trim();
        if (text) entries.push({ role: 'assistant', text });
      }
    }
    return entries;
  }
  function lastAssistantInfo(branch: BranchEntry[]) {
    const history = toHistory(branch);
    const last = [...history].reverse().find((e) => e.role === 'assistant');
    return last ? { entryId: `e-${last.text}`, text: last.text } : null;
  }

  // ── Module mocks ──────────────────────────────────────────────────────────
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return { ...actual, homedir: () => tmpDir };
  });

  vi.doMock('../../src/auth/challenge.js', () => ({
    ChallengeAuth: class {
      getNotificationChatId() { return state.trustedChatId; }
      getStats() { return { trustedUser: 'testuser', channels: 0 }; }
      loadFromConfig() {}
      exportConfig() { return {}; }
      releaseClaim() { return 0; }
    },
  }));

  vi.doMock('../../src/slack/client.js', () => ({
    SlackClient: MockSlackClient,
  }));

  vi.doMock('../../src/session/lock.js', () => ({
    acquireLock: vi.fn(() => true),
    forceAcquireLock: vi.fn(() => null),
    isLockHeldLocally: vi.fn(() => true),
    isCurrentLockOwner: vi.fn(() => true),
    releaseLock: vi.fn(),
    getInstanceId: vi.fn(() => 'inst'),
    getLockOwner: vi.fn(() => null),
  }));

  vi.doMock('../../src/session/tmux.js', () => ({
    runTmuxPiConnect: tmuxMock.runTmuxPiConnect,
    resolvePathInput: tmuxMock.resolvePathInput,
    buildTmuxConnectSummary: tmuxMock.buildTmuxConnectSummary,
  }));

  vi.doMock('../../src/session/handlers.js', () => ({
    getConversationHistory: () => toHistory(state.branch),
    getLastAssistantMessageInfo: () => lastAssistantInfo(state.branch),
    buildSlackFooterText: vi.fn().mockResolvedValue('footer'),
    listRecentSessions: vi.fn().mockResolvedValue([]),
    buildSessionListText: vi.fn().mockResolvedValue(''),
  }));

  // Stateful config mock so routing.ts mutations persist via saveConfig.
  const configState: any = {
    slack: { botToken: 'xoxb-test', appToken: 'xapp-test' },
    autoConnect: state.autoConnect,
    hideToolCalls: state.hideToolCalls,
    slackRouting: state.slackRouting,
    optedOutSessions: state.optedOutSessions,
  };
  vi.doMock('../../src/config/index.js', () => ({
    loadConfig: vi.fn(() => configState),
    saveConfig: vi.fn((cfg: any) => {
      Object.assign(configState, cfg);
    }),
  }));

  vi.doMock('../../src/ui/main-menu.js', () => ({
    openMainMenu: vi.fn(),
  }));

  const bridge = await import('../../src/bridge/index');
  bridge.default(pi);

  const sessionCtx = {
    sessionManager: {
      getSessionFile: () => state.sessionFile,
      getBranch: () => state.branch,
    },
    cwd: state.cwd,
    model: { provider: 'test', id: 'model', contextWindow: 8000 },
    getContextUsage: () => ({ percent: 50, contextWindow: 8000 }),
    isIdle: () => state.agentIdle,
    ui: {
      notify: vi.fn((message: string, level: string) => notifyCalls.push([message, level])),
      setStatus: vi.fn(),
    },
  };

  return {
    pi,
    registeredCommand,
    capturedOn,
    get slackClient() { return createdSlackClient; },
    tmux: tmuxMock,
    clientOnMessage,
    sendCalls,
    notifyCalls,
    sessionCtx,
    tmpDir,
    state,
    async sessionStart() {
      const handler = capturedOn.get('session_start');
      if (handler) await handler({}, sessionCtx);
    },
    async invokeCommand(args, cmdCtx) {
      const ctx2 = cmdCtx ?? {
        ui: { notify: (m: string, l: string) => notifyCalls.push([m, l]) },
        isIdle: () => state.cmdIdle,
      };
      await registeredCommand.handler(args, ctx2);
    },
    async invokeAgentEnd(event) {
      const handler = capturedOn.get('agent_end');
      if (handler) await handler(event, sessionCtx);
    },
    async invokeClientMessage(msg) {
      clientOnMessage(msg);
      // The bridge's handler is fire-and-forget (`void handleIncomingRemoteMessage`);
      // await a macrotask so the all-mocked async chain completes before assertions.
      await new Promise((r) => setTimeout(r, 0));
    },
    async sessionShutdown() {
      const handler = capturedOn.get('session_shutdown');
      if (handler) await handler({}, sessionCtx);
    },
    setDeferSends(on: boolean) {
      deferSends = on;
    },
    resolveSend(i: number, ts?: string) {
      deferredSends[i]?.(ts);
    },
    resolveAllSends(ts?: string) {
      while (deferredSends.length > 0) {
        deferredSends.shift()?.(ts);
      }
    },
    sendUserMessages() {
      return pi.sendUserMessage.mock.calls as any[];
    },
    reset() {
      delete g.__slkBridgeConnected;
      delete g.__slkBridgeOwner;
      delete g.__slkBridgeInstanceId;
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
