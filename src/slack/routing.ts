/**
 * routing.ts — Slack thread-to-session routing state.
 *
 * Manages the mapping between Slack threads and pi session files,
 * so incoming thread replies can be routed to the correct session.
 */

import { loadConfig, saveConfig } from "../config/index.js";

// ── Key helpers ────────────────────────────────────────────────────────────

export function getSlackThreadKey(chatId: string, threadTs: string): string {
  return `${chatId}:${threadTs}`;
}

export function getSlackSessionChatKey(sessionPath: string, chatId: string): string {
  return `${sessionPath}:${chatId}`;
}

// ── State accessors ────────────────────────────────────────────────────────

export function getSlackRoutingState() {
  const config = loadConfig();
  const threadsByKey = { ...(config.slackRouting?.threadsByKey ?? {}) };
  const activeThreadBySessionChat = { ...(config.slackRouting?.activeThreadBySessionChat ?? {}) };
  const lastAssistantDeliveryByThread = { ...(config.slackRouting?.lastAssistantDeliveryByThread ?? {}) };
  return { config, threadsByKey, activeThreadBySessionChat, lastAssistantDeliveryByThread };
}

// ── Mutations ──────────────────────────────────────────────────────────────

export function rememberSlackThreadForSession(
  chatId: string,
  threadTs: string,
  sessionPath?: string,
  getCurrentSessionFile?: () => string | undefined,
): void {
  if (!threadTs) return;

  const resolvedSessionPath = sessionPath ?? getCurrentSessionFile?.();
  if (!resolvedSessionPath) return;

  const { config, threadsByKey, activeThreadBySessionChat, lastAssistantDeliveryByThread } = getSlackRoutingState();
  const updatedAt = new Date().toISOString();
  threadsByKey[getSlackThreadKey(chatId, threadTs)] = {
    sessionPath: resolvedSessionPath,
    updatedAt,
  };
  activeThreadBySessionChat[getSlackSessionChatKey(resolvedSessionPath, chatId)] = {
    threadTs,
    updatedAt,
  };
  config.slackRouting = { threadsByKey, activeThreadBySessionChat, lastAssistantDeliveryByThread };
  saveConfig(config);
}

export function markLatestAssistantDeliveredToSlackThread(
  chatId: string,
  threadTs: string,
  sessionPath?: string,
  getCurrentSessionFile?: () => string | undefined,
  getLastAssistantMessageInfo?: () => { entryId: string; text: string } | null,
): void {
  if (!threadTs) return;

  const resolvedSessionPath = sessionPath ?? getCurrentSessionFile?.();
  const lastAssistantMessage = getLastAssistantMessageInfo?.();
  if (!resolvedSessionPath || !lastAssistantMessage) return;

  const { config, threadsByKey, activeThreadBySessionChat, lastAssistantDeliveryByThread } = getSlackRoutingState();
  lastAssistantDeliveryByThread[getSlackThreadKey(chatId, threadTs)] = {
    sessionPath: resolvedSessionPath,
    assistantEntryId: lastAssistantMessage.entryId,
    updatedAt: new Date().toISOString(),
  };
  config.slackRouting = { threadsByKey, activeThreadBySessionChat, lastAssistantDeliveryByThread };
  saveConfig(config);
}

export function hasLatestAssistantBeenDeliveredToSlackThread(
  chatId: string,
  threadTs: string,
  sessionPath?: string,
  getCurrentSessionFile?: () => string | undefined,
  getLastAssistantMessageInfo?: () => { entryId: string; text: string } | null,
): boolean {
  const resolvedSessionPath = sessionPath ?? getCurrentSessionFile?.();
  const lastAssistantMessage = getLastAssistantMessageInfo?.();
  if (!resolvedSessionPath || !lastAssistantMessage) return false;

  const { lastAssistantDeliveryByThread } = getSlackRoutingState();
  const record = lastAssistantDeliveryByThread[getSlackThreadKey(chatId, threadTs)];
  return record?.sessionPath === resolvedSessionPath && record?.assistantEntryId === lastAssistantMessage.entryId;
}

export function getSlackThreadOwnerSession(chatId: string, threadTs?: string): string | undefined {
  if (!threadTs) return undefined;
  const { threadsByKey } = getSlackRoutingState();
  return threadsByKey[getSlackThreadKey(chatId, threadTs)]?.sessionPath;
}

export function getRememberedSlackThreadForCurrentSession(
  chatId: string,
  slackSessionThreads: Map<string, string>,
  getCurrentSessionFile?: () => string | undefined,
): string | undefined {
  const inMemory = slackSessionThreads.get(chatId);
  if (inMemory) return inMemory;

  const sessionPath = getCurrentSessionFile?.();
  if (!sessionPath) return undefined;

  const { activeThreadBySessionChat } = getSlackRoutingState();
  const threadTs = activeThreadBySessionChat[getSlackSessionChatKey(sessionPath, chatId)]?.threadTs;
  if (threadTs) {
    slackSessionThreads.set(chatId, threadTs);
  }
  return threadTs;
}
