/**
 * flow003-continuation.test.ts — FLOW-003: Continue the conversation from the
 * pushed Slack thread.
 *
 * Pinned requirements (anti-regression):
 *  - Immediate pickup: a reply in the handover thread reaches the agent with no delay.
 *  - Single ingestion: the message is processed exactly once — no duplicate turns.
 *  - The reply lands in the same thread the user replied in.
 *
 * Scenario (end-to-end within the harness):
 *  1. Idle handover (`/slk-bridge handover`) pushes history into a new thread
 *     and remembers that thread → this session.
 *  2. A reply arrives in that thread.
 *  3. It must route back to THIS session (no handoff), and be sent to the agent
 *     exactly once, immediately, with the tagged Slack prefix.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createBridgeHarness } from '../helpers/bridge-harness';

describe('FLOW-003 continuation after handover', () => {
  let h: Awaited<ReturnType<typeof createBridgeHarness>>;

  afterEach(async () => {
    await h.sessionShutdown();
    h.reset();
  });

  it('a reply in the handover thread is routed to the same session and ingested exactly once', async () => {
    const userText = 'first user message';
    const assistantText = 'first assistant response';

    h = await createBridgeHarness({
      branch: [
        { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: userText }] } },
        { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: assistantText }], stopReason: 'stop' } },
      ],
      sessionFile: '/tmp/session-1',
      cwd: '/tmp/project',
      trustedChatId: 'D123',
      cmdIdle: true, // idle handover
      agentIdle: true, // agent idle when the reply arrives
      autoConnect: false,
    });

    await h.sessionStart();

    // 1. Idle handover → pushes header + history, remembers thread ts-1 → session.
    await h.invokeCommand('handover');

    // Header is the first send; the created thread ts is "ts-1".
    expect(h.sendCalls[0].text).toBe('🔄 Terminal session pushed to Slack');
    const handoverThreadTs = 'ts-1';

    // 2. A reply arrives in that thread.
    await h.invokeClientMessage({
      chatId: 'D123',
      content: 'continue here',
      username: 'testuser',
      userId: 'U123',
      timestamp: new Date(),
      messageId: 'ts-2',
      isGroupChat: false,
      wasMentioned: false,
      threadId: handoverThreadTs,
      isThreadReply: true,
    });

    // 3. Assertions — THE PINNED REQUIREMENTS.

    // No handoff to another session: the thread maps to this session, so the
    // reply must NOT spawn a tmux handoff.
    expect(h.tmux.runTmuxPiConnect).not.toHaveBeenCalled();

    // The reply is ingested EXACTLY ONCE, with the tagged Slack prefix.
    const calls = h.sendUserMessages();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('[📱 @testuser via Slack]: continue here');
    // Idle agent → no followUp flag.
    expect(calls[0][1]).toBeUndefined();

    // A working reaction was set on the incoming message.
    expect(h.slackClient.addReaction).toHaveBeenCalledTimes(1);
    expect(h.slackClient.addReaction.mock.calls[0][0]).toBe('D123');
    expect(h.slackClient.addReaction.mock.calls[0][1]).toBe('ts-2');
  });

  it('after a BUSY handover, a reply in the new thread is ingested exactly once and not queued as followUp (agent idle)', async () => {
    const userText = 'first user message';
    const finalAssistantText = 'final assistant response';

    h = await createBridgeHarness({
      branch: [
        { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: userText }] } },
        { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: finalAssistantText }], stopReason: 'stop' } },
      ],
      sessionFile: '/tmp/session-1',
      cwd: '/tmp/project',
      trustedChatId: 'D123',
      cmdIdle: false, // BUSY handover
      agentIdle: true, // agent idle when the reply arrives
      autoConnect: false,
    });

    await h.sessionStart();

    // 1. Busy handover: fire the command (it waits for agent_end), then drive agent_end
    //    which creates the new thread and pushes history + final response.
    const cmdCtx = { ui: { notify: (m: string, l: string) => h.notifyCalls.push([m, l]) }, isIdle: () => h.state.cmdIdle };
    const cmdPromise = h.registeredCommand.handler('handover', cmdCtx);
    await h.invokeAgentEnd({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: finalAssistantText }], stopReason: 'stop' }],
    });
    await cmdPromise;

    // The new thread was created (header) and remembered.
    expect(h.sendCalls[0].text).toBe('🔄 Terminal session pushed to Slack');
    const handoverThreadTs = 'ts-1';

    // 2. Now a reply arrives in that thread while the agent is idle.
    await h.invokeClientMessage({
      chatId: 'D123',
      content: 'continue here',
      username: 'testuser',
      userId: 'U123',
      timestamp: new Date(),
      messageId: 'ts-2',
      isGroupChat: false,
      wasMentioned: false,
      threadId: handoverThreadTs,
      isThreadReply: true,
    });

    // 3. Pinned requirements: single ingestion, not queued as followUp, no handoff.
    expect(h.tmux.runTmuxPiConnect).not.toHaveBeenCalled();
    const calls = h.sendUserMessages();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('[📱 @testuser via Slack]: continue here');
    expect(calls[0][1]).toBeUndefined();
  });

  it('after a BUSY handover, agent_end must NOT block on the sequential history push', async () => {
    const userText = 'first user message';
    const finalAssistantText = 'final assistant response';

    h = await createBridgeHarness({
      branch: [
        { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: userText }] } },
        { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: finalAssistantText }], stopReason: 'stop' } },
      ],
      sessionFile: '/tmp/session-1',
      cwd: '/tmp/project',
      trustedChatId: 'D123',
      cmdIdle: false, // BUSY handover
      agentIdle: true,
      autoConnect: false,
    });

    await h.sessionStart();
    h.setDeferSends(true); // simulate slow Slack API

    const cmdCtx = { ui: { notify: (m: string, l: string) => h.notifyCalls.push([m, l]) }, isIdle: () => h.state.cmdIdle };
    const cmdPromise = h.registeredCommand.handler('handover', cmdCtx); // waits for agent_end

    // Fire agent_end WITHOUT awaiting: it will send header (send 0), then history
    // (sends 1..n) all deferred. Resolve ONLY the header, leaving history pending.
    const agentEndPromise = h.invokeAgentEnd({
      messages: [{ role: 'assistant', content: [{ type: 'text', text: finalAssistantText }], stopReason: 'stop' }],
    });

    // Let the header send get pushed into deferredSends (sendToRemoteChat awaits
    // buildSlackFooterText first, a microtask), then resolve ONLY the header.
    await new Promise((r) => setTimeout(r, 0));
    h.resolveSend(0);

    // THE REQUIREMENT: agent_end / the busy handover command must complete after the
    // header alone — the history replay must be backgrounded, not awaited inline.
    // On the current code, branch 2 awaits all history sends, so cmdPromise stays
    // pending → this is RED. After backgrounding, it resolves → GREEN.
    const settled = await Promise.race([
      cmdPromise.then(() => true, () => true),
      new Promise<false>((r) => setTimeout(() => r(false), 100)),
    ]);

    expect(settled).toBe(true);

    // Cleanup: resolve any still-deferred sends so nothing hangs.
    h.resolveAllSends('ts-1');
    await agentEndPromise;
  });
});
