/**
 * flow002-handover.test.ts — FLOW-002: /slk-bridge handover (busy case).
 *
 * Pinned requirement (anti-regression): in the busy case the push is
 * *history + final message*, and the final assistant message must appear
 * exactly once in the pushed thread — never duplicated.
 *
 * This test is expected to FAIL on the current code (duplicate final message)
 * and go green once we self-correct. It also proves the harness can drive
 * session_start → slk-bridge command → agent_end.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createBridgeHarness } from '../helpers/bridge-harness';

describe('FLOW-002 handover (busy)', () => {
  let h: Awaited<ReturnType<typeof createBridgeHarness>>;

  afterEach(async () => {
    await h.sessionShutdown();
    h.reset();
  });

  it('busy handover pushes history + final message, with the final message appearing exactly once', async () => {
    const finalAssistantText = 'final assistant response';
    const userText = 'first user message';
    const firstAssistantText = 'first assistant response';

    h = await createBridgeHarness({
      branch: [
        { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: userText }] } },
        { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: firstAssistantText }], stopReason: 'stop' } },
        { type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: finalAssistantText }], stopReason: 'stop' } },
      ],
      sessionFile: '/tmp/session-1',
      cwd: '/tmp/project',
      trustedChatId: 'D123',
      cmdIdle: false, // busy agent
      agentIdle: true,
      autoConnect: false,
    });

    await h.sessionStart();

    // Busy handover: fire the command (it awaits agent_end), then drive agent_end.
    const cmdCtx = { ui: { notify: (m: string, l: string) => h.notifyCalls.push([m, l]) }, isIdle: () => h.state.cmdIdle };
    const cmdPromise = h.registeredCommand.handler('handover', cmdCtx);

    await h.invokeAgentEnd({
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: finalAssistantText }], stopReason: 'stop' },
      ],
    });
    await cmdPromise;

    // The history push is now backgrounded (fire-and-forget), so flush it.
    await new Promise((r) => setTimeout(r, 0));

    // Pushed thread messages (exclude the header).
    const pushed = h.sendCalls.filter((c) => c.text !== '🔄 Terminal session pushed to Slack');

    // History is present, in order: user, first assistant, final assistant.
    expect(pushed.map((c) => c.text)).toEqual([
      `🗣️ **User:** ${userText}`,
      firstAssistantText,
      finalAssistantText,
    ]);

    // THE PINNED REQUIREMENT: the final assistant message appears exactly once.
    const finalCount = pushed.filter((c) => c.text === finalAssistantText).length;
    expect(finalCount).toBe(1);
  });

  it('confirms the handover to the terminal user', async () => {
    h = await createBridgeHarness({
      branch: [
        { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
        { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }], stopReason: 'stop' } },
      ],
      sessionFile: '/tmp/session-1',
      cwd: '/tmp/project',
      trustedChatId: 'D123',
      cmdIdle: false,
      agentIdle: true,
      autoConnect: false,
    });

    await h.sessionStart();

    const cmdCtx = { ui: { notify: (m: string, l: string) => h.notifyCalls.push([m, l]) }, isIdle: () => h.state.cmdIdle };
    const cmdPromise = h.registeredCommand.handler('handover', cmdCtx);
    await h.invokeAgentEnd({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi there' }], stopReason: 'stop' }],
    });
    await cmdPromise;

    expect(h.notifyCalls.some(([m]) => m.includes('Waiting for agent to finish'))).toBe(true);
    expect(h.notifyCalls.some(([m]) => m.includes('Session pushed to Slack'))).toBe(true);
  });
});
