/**
 * replay.ts — Extracted, reusable session message replay logic.
 *
 * The replay functionality was previously duplicated inline in bridge/index.ts
 * (replayAllAssistantMessagesToSlackThread / notifySlackSessionHandover).
 * This module provides dependency-injected interfaces so any consumer
 * (bridge commands, handoff handlers, etc.) can replay conversation history
 * to Slack without coupling to the full bridge lifecycle.
 */

import type { ConversationEntry } from "../session/handlers.js";

// ── Abstractions consumed by the replay functions ──────────────────────────

/** Minimal sender: enough to post messages into a Slack thread. */
export interface SlackSender {
  sendToRemoteChat(
    chatId: string,
    text: string,
    options?: { threadId?: string; forceTopLevel?: boolean; noFooter?: boolean },
  ): Promise<string | undefined>;
}

/** Tracks whether the latest assistant message has already been delivered. */
export interface DeliveryTracker {
  hasLatestAssistantBeenDelivered(
    chatId: string,
    threadTs: string,
    getCurrentSessionFile: () => string | undefined,
    getLastAssistantMessageInfo: () => { entryId: string; text: string } | null,
  ): boolean;

  markLatestAssistantDelivered(
    chatId: string,
    threadTs: string,
    getCurrentSessionFile: () => string | undefined,
    getLastAssistantMessageInfo: () => { entryId: string; text: string } | null,
  ): void;
}

/** Provides conversation history and current session metadata. */
export interface ConversationProvider {
  getConversationHistory(): ConversationEntry[];
  getLastAssistantMessageInfo(): { entryId: string; text: string } | null;
  getCurrentSessionFile(): string | undefined;
}

// ── Replay into an existing thread (deduplicates) ──────────────────────────

/**
 * Replay all conversation entries into an existing Slack thread.
 * Skips if the latest assistant message has already been delivered to that
 * thread (deduplication for handover scenarios).
 */
export async function replayConversationToExistingThread(
  chatId: string,
  threadTs: string,
  sender: SlackSender,
  tracker: DeliveryTracker,
  conversation: ConversationEntry[],
  getCurrentSessionFile: () => string | undefined,
  getLastAssistantMessageInfo: () => { entryId: string; text: string } | null,
): Promise<void> {
  if (tracker.hasLatestAssistantBeenDelivered(
    chatId,
    threadTs,
    getCurrentSessionFile,
    getLastAssistantMessageInfo,
  )) {
    return;
  }

  if (conversation.length === 0) {
    return;
  }

  for (const entry of conversation) {
    const text = entry.role === "user"
      ? `🗣️ **User:** ${entry.text}`
      : entry.text;
    await sender.sendToRemoteChat(chatId, text, { threadId: threadTs });
  }

  tracker.markLatestAssistantDelivered(
    chatId,
    threadTs,
    getCurrentSessionFile,
    getLastAssistantMessageInfo,
  );
}

// ── Replay into a fresh top-level thread ───────────────────────────────────

/**
 * Replay all conversation entries into a brand-new top-level thread.
 * Returns the new thread timestamp, or undefined if the header message failed.
 *
 * Optionally marks delivery via a tracker so subsequent replays are idempotent.
 */
export async function replayConversationToNewThread(
  chatId: string,
  sender: SlackSender,
  headerMessage: string,
  conversation: ConversationEntry[],
  options?: {
    tracker?: DeliveryTracker;
    getCurrentSessionFile?: () => string | undefined;
    getLastAssistantMessageInfo?: () => { entryId: string; text: string } | null;
  },
): Promise<string | undefined> {
  const threadTs = await sender.sendToRemoteChat(chatId, headerMessage, {
    forceTopLevel: true,
  });
  if (!threadTs) return undefined;

  for (const entry of conversation) {
    const text = entry.role === "user"
      ? `🗣️ **User:** ${entry.text}`
      : entry.text;
    await sender.sendToRemoteChat(chatId, text, { threadId: threadTs });
  }

  if (options?.tracker && options?.getCurrentSessionFile && options?.getLastAssistantMessageInfo) {
    options.tracker.markLatestAssistantDelivered(
      chatId,
      threadTs,
      options.getCurrentSessionFile,
      options.getLastAssistantMessageInfo,
    );
  }

  return threadTs;
}
