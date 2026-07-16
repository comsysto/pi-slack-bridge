/**
 * pi-slack-bridge extension
 * Bridges Slack into pi — a pure Slack remote control surface for the pi coding agent.
 *
 * Architecture:
 *   bridge/index.ts   — Extension lifecycle wiring (session hooks, message routing, command registration)
 *   slack/client.ts   — Slack API client (connect, send, receive, reactions, file upload)
 *   slack/routing.ts  — Thread-to-session mapping state
 *   slack/blocks.ts   — Markdown → Slack Block Kit conversion
 *   slack/formatting.ts — Message splitting, truncation, tool call formatting
 *   session/lock.ts   — Single-instance connection guard (global flag + PID lock file)
 *   session/tmux.ts   — Tmux session spawning for fresh bridge sessions
 *   session/handlers.ts — Session-level helpers (conversation history, footer text, session listing)
 *   session/replay.ts   — Message replay engine for session handoff
 *   auth/challenge.ts — Challenge-based user authentication
 *   config/index.ts   — File + env var config loading/saving
 *   types/index.ts    — Shared type definitions
 *   bridge/commands.ts — Shared command definitions (status text, help text, remote command list)
 *   ui/main-menu.ts   — Interactive TUI main menu
 *   ui/status-widget.ts — Status widget
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Type } from "typebox";
import { ChallengeAuth } from "../auth/challenge.js";
import { loadConfig, saveConfig } from "../config/index.js";
import {
  buildSessionListText,
  buildSlackFooterText,
  getConversationHistory,
  getLastAssistantMessageInfo,
  listRecentSessions,
} from "../session/handlers.js";
import {
  acquireLock,
  forceAcquireLock,
  getInstanceId,
  isCurrentLockOwner,
  isLockHeldLocally,
  releaseLock,
} from "../session/lock.js";
import { buildTmuxConnectSummary, resolvePathInput, runTmuxPiConnect } from "../session/tmux.js";
import { SlackClient } from "../slack/client.js";
import {
  extractTextFromMessage,
  formatToolCalls,
} from "../slack/formatting.js";
import {
  getRememberedSlackThreadForCurrentSession,
  getSlackThreadOwnerSession,
  hasLatestAssistantBeenDeliveredToSlackThread,
  markLatestAssistantDeliveredToSlackThread,
  rememberSlackThreadForSession,
} from "../slack/routing.js";
import type { ExternalMessage, PendingRemoteChat } from "../types/index.js";
import { openMainMenu } from "../ui/main-menu.js";
import { createStatusWidget } from "../ui/status-widget.js";
import {
  buildBridgeHelpText,
  buildBridgeStatusText,
  buildRemoteCommandList,
  getSlackHandoverReasonText,
} from "./commands.js";

export default function (pi: ExtensionAPI): void {
  let slackClient: SlackClient | null = null;
  let pendingRemoteChat: PendingRemoteChat | null = null;
  let auth: ChallengeAuth;
  let ctx: ExtensionContext;
  let ownershipTimer: NodeJS.Timeout | undefined;
  let ownershipCheckInProgress = false;
  const slackSessionThreads = new Map<string, string>();
  let activeSlackReaction: { chatId: string; messageId: string } | null = null;
  let turnAccumulator: {
    chatId: string;
    entries: string[];
    threadId?: string;
  } | null = null;
  const handoffDir = path.join(os.homedir(), ".pi", "slk-bridge-handoffs");

  // ── Short-lived helpers (bridge state accessors) ──────────────────────────

  function getCurrentSessionFile(): string | undefined {
    return ctx.sessionManager.getSessionFile();
  }

  function ownsBridgeConnection(): boolean {
    return isLockHeldLocally() && isCurrentLockOwner();
  }

  function hasConfiguredSlack(): boolean {
    return slackClient !== null;
  }

  function slackIsConnected(): boolean {
    return slackClient?.isConnected ?? false;
  }

  function getSlackClient(): SlackClient | null {
    return slackClient;
  }

  function toPendingRemoteChat(message: ExternalMessage): PendingRemoteChat {
    return {
      chatId: message.chatId,
      username: message.username,
      messageId: message.messageId,
      threadId: message.threadId,
      isThreadReply: message.isThreadReply,
    };
  }

  /** Resolve a thread ID: prefer explicit, fall back to remembered */
  function resolveThreadId(chatId: string, explicitThreadId?: string): string | undefined {
    return explicitThreadId || getRememberedSlackThreadForCurrentSession(chatId, slackSessionThreads, getCurrentSessionFile);
  }

  // ── Handoff directory ────────────────────────────────────────────────────

  function ensureHandoffDir(): void {
    if (!fs.existsSync(handoffDir)) {
      fs.mkdirSync(handoffDir, { recursive: true, mode: 0o700 });
    }
  }

  // ── Slack reaction helpers ───────────────────────────────────────────────

  async function clearSlackWorkingReaction(): Promise<void> {
    if (!activeSlackReaction) return;

    const reactionTarget = activeSlackReaction;
    activeSlackReaction = null;
    const slack = getSlackClient();
    if (!slack) return;

    try {
      await slack.removeReaction(reactionTarget.chatId, reactionTarget.messageId, "hourglass_flowing_sand");
    } catch {
      // Ignore cleanup failures
    }
  }

  async function setSlackWorkingReaction(remoteChat: PendingRemoteChat | null): Promise<void> {
    if (!remoteChat) {
      await clearSlackWorkingReaction();
      return;
    }

    if (
      activeSlackReaction &&
      activeSlackReaction.chatId === remoteChat.chatId &&
      activeSlackReaction.messageId === remoteChat.messageId
    ) {
      return;
    }

    await clearSlackWorkingReaction();
    const slack = getSlackClient();
    if (!slack) return;

    try {
      await slack.addReaction(remoteChat.chatId, remoteChat.messageId, "hourglass_flowing_sand");
      activeSlackReaction = {
        chatId: remoteChat.chatId,
        messageId: remoteChat.messageId,
      };
    } catch {
      // Ignore reaction failures so normal messaging still works
    }
  }

  // ── Send to Slack ────────────────────────────────────────────────────────

  async function sendToRemoteChat(
    chatId: string,
    text: string,
    options?: {
      threadId?: string;
      forceTopLevel?: boolean;
      rememberThreadForSessionPath?: string;
      noFooter?: boolean;
    },
  ): Promise<string | undefined> {
    const slack = getSlackClient();
    if (!slack) return undefined;

    const threadTs = options?.forceTopLevel
      ? undefined
      : resolveThreadId(chatId, options?.threadId);
    const footerText = options?.noFooter ? undefined : await buildSlackFooterText(ctx);
    const rootThreadTs = await slack.sendMessageInThread(chatId, text, threadTs, footerText);
    if (rootThreadTs) {
      rememberSlackThreadForSession(chatId, rootThreadTs, options?.rememberThreadForSessionPath, getCurrentSessionFile);
    }
    return rootThreadTs;
  }

  async function sendRemoteText(message: ExternalMessage, text: string): Promise<void> {
    await sendToRemoteChat(message.chatId, text, {
      threadId: message.threadId,
    });
  }

  async function sendSlackFileToCurrentChat(
    filePathInput: string,
    options?: { title?: string; initialComment?: string },
    remoteChat: PendingRemoteChat | null = pendingRemoteChat,
  ): Promise<string> {
    if (!remoteChat || !ownsBridgeConnection()) {
      throw new Error("No active remote chat is available for file upload");
    }


    const filePath = path.isAbsolute(filePathInput)
      ? filePathInput
      : path.join(ctx.cwd, filePathInput);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    const threadId = resolveThreadId(remoteChat.chatId, remoteChat.threadId);
    if (threadId) {
      rememberSlackThreadForSession(remoteChat.chatId, threadId, undefined, getCurrentSessionFile);
    }

    if (!slackClient) {
      throw new Error("Slack client not available");
    }
    await slackClient.sendFile(remoteChat.chatId, filePath, {
      title: options?.title,
      initialComment: options?.initialComment,
      threadId,
    });

    return filePath;
  }

  // ── Replay / handover ────────────────────────────────────────────────────

  async function replayAllAssistantMessagesToSlackThread(remoteChat: PendingRemoteChat): Promise<void> {
    if (!remoteChat.threadId) {
      return;
    }

    if (hasLatestAssistantBeenDeliveredToSlackThread(
      remoteChat.chatId,
      remoteChat.threadId,
      undefined,
      getCurrentSessionFile,
      () => getLastAssistantMessageInfo(ctx.sessionManager),
    )) {
      return;
    }

    const conversation = getConversationHistory(ctx.sessionManager);
    if (conversation.length === 0) {
      return;
    }

    for (const entry of conversation) {
      const text = entry.role === "user"
        ? `🗣️ **User:** ${entry.text}`
        : entry.text;
      await sendToRemoteChat(remoteChat.chatId, text, {
        threadId: remoteChat.threadId,
      });
    }

    markLatestAssistantDeliveredToSlackThread(
      remoteChat.chatId,
      remoteChat.threadId,
      undefined,
      getCurrentSessionFile,
      () => getLastAssistantMessageInfo(ctx.sessionManager),
    );
  }

  async function notifySlackSessionHandover(reason?: "user-request" | "active-session"): Promise<void> {
    const slackChats = auth.getNotificationChatIds();
    if (slackChats.length === 0) return;

    const handoverMessage = [
      "🔄 Session changed",
      getSlackHandoverReasonText(reason),
    ].join("\n");

    // Fire the full conversation replay as a background task so connectCurrentSession
    // returns quickly — pi can process the user's input without waiting for 50 Slack API calls.
    const conversation = getConversationHistory(ctx.sessionManager);
    void (async () => {
      for (const chatId of slackChats) {
        try {
          const threadTs = await sendToRemoteChat(chatId, handoverMessage, {
            forceTopLevel: true,
          });

          for (const entry of conversation) {
            const text = entry.role === "user"
              ? `🗣️ **User:** ${entry.text}`
              : entry.text;
            await sendToRemoteChat(chatId, text, { threadId: threadTs });
          }

          if (threadTs && conversation.length > 0) {
            markLatestAssistantDeliveredToSlackThread(
              chatId,
              threadTs,
              undefined,
              getCurrentSessionFile,
              () => getLastAssistantMessageInfo(ctx.sessionManager),
            );
          }
        } catch {
          // Ignore notification failures
        }
      }
    })();
  }

  // ── Connect / disconnect ─────────────────────────────────────────────────

  async function connectCurrentSession(options?: {
    respectAutoConnect?: boolean;
    showTakeoverNotice?: boolean;
    notifySlackHandover?: boolean;
    handoverReason?: "user-request" | "active-session";
  }): Promise<boolean> {

    const config = loadConfig();
    if ((options?.respectAutoConnect ?? false) && config.autoConnect === false) {
      return false;
    }
    if (!hasConfiguredSlack()) {
      return false;
    }

    const alreadyOwner = ownsBridgeConnection();
    const previousOwner = alreadyOwner ? null : forceAcquireLock();
    const tookOver = !!previousOwner && (previousOwner.pid !== process.pid || previousOwner.owner !== getInstanceId());

    if (options?.showTakeoverNotice && tookOver) {
      ctx.ui.notify("🔄 Taking over slk-bridge connection from another session...", "info");
    }

    if (alreadyOwner && slackIsConnected()) {
      return false;
    }

    if (tookOver) {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    try {
      if (slackClient) {
        await slackClient.connect();
      }
      updateWidget();
      if (tookOver && options?.notifySlackHandover !== false) {
        await notifySlackSessionHandover(options?.handoverReason);
      }
      return tookOver;
    } catch (err) {
      if (!alreadyOwner) {
        releaseLock();
      }
      updateWidget();
      throw err;
    }
  }

  async function disconnectCurrentSession(): Promise<void> {
    if (slackClient) {
      await slackClient.disconnect();
    }
    releaseLock();
    const cfg = loadConfig();
    cfg.autoConnect = false;
    saveConfig(cfg);
    updateWidget();
  }

  async function startFreshBridgeSession(cwdArg?: string): Promise<string> {
    const cwd = resolvePathInput(cwdArg?.trim() ? cwdArg : ctx.cwd, ctx.cwd);
    const result = await runTmuxPiConnect({
      cwd,
      bridgeCommand: "/slk-bridge connect user-request",
    });
    return buildTmuxConnectSummary(result);
  }

  async function switchToListedBridgeSession(index: number): Promise<string> {
    const sessions = await listRecentSessions();
    const selected = sessions[index - 1];
    if (!selected) {
      throw new Error(`Session #${index} is not in the current recent-session list`);
    }

    const cwd = selected.cwd === "(unknown cwd)" ? ctx.cwd : selected.cwd;
    const result = await runTmuxPiConnect({
      cwd,
      piArgs: ["--session", selected.path],
      bridgeCommand: "/slk-bridge connect user-request",
    });
    return buildTmuxConnectSummary(result);
  }

  // ── Message handling ─────────────────────────────────────────────────────

  function isExplicitRemoteSwitchCommand(message: ExternalMessage): boolean {
    return /^\.bridge\s+switch(?:\s|$)/i.test(message.content.trim());
  }

  async function forwardRemoteCommandToPi(message: ExternalMessage, text: string): Promise<void> {
    pendingRemoteChat = toPendingRemoteChat(message);
    const explicitSwitchCommand = isExplicitRemoteSwitchCommand(message);

    if (message.threadId && !explicitSwitchCommand) {
      rememberSlackThreadForSession(message.chatId, message.threadId, undefined, getCurrentSessionFile);
    }
    if (ctx.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
  }

  async function handoffSlackThreadToSession(message: ExternalMessage, targetSessionPath: string): Promise<void> {
    const sessions = await listRecentSessions();
    const targetSession = sessions.find((session) => session.path === targetSessionPath);
    if (!targetSession) {
      throw new Error(`Mapped Slack thread session not found: ${targetSessionPath}`);
    }

    ensureHandoffDir();
    const handoffFile = path.join(
      handoffDir,
      `handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.json`,
    );

    fs.writeFileSync(
      handoffFile,
      JSON.stringify({
        message: {
          ...message,
          timestamp: message.timestamp.toISOString(),
        },
        replayLastAssistantMessage: true,
      }),
      { mode: 0o600 },
    );

    try {
      await runTmuxPiConnect({
        cwd: targetSession.cwd || ctx.cwd,
        piArgs: ["--session", targetSessionPath],
        bridgeCommand: `/slk-bridge accept-handoff ${handoffFile}`,
        attachClient: false,
        cleanupOtherSessions: false,
      });
    } catch (err) {
      try {
        fs.unlinkSync(handoffFile);
      } catch {
        // Ignore cleanup failures
      }
      throw err;
    }
  }

  async function maybeRouteSlackMessageToMappedSession(message: ExternalMessage): Promise<boolean> {
    if (message.isGroupChat || !message.threadId) {
      return false;
    }

    if (isExplicitRemoteSwitchCommand(message)) {
      return false;
    }

    const currentSessionPath = getCurrentSessionFile();
    const mappedSessionPath = getSlackThreadOwnerSession(message.chatId, message.threadId);

    if (message.isThreadReply && mappedSessionPath && mappedSessionPath !== currentSessionPath) {
      await handoffSlackThreadToSession(message, mappedSessionPath);
      return true;
    }

    rememberSlackThreadForSession(message.chatId, message.threadId, undefined, getCurrentSessionFile);
    return false;
  }

  async function handleIncomingRemoteMessage(
    message: ExternalMessage,
    options?: {
      allowSessionRouting?: boolean;
      replayLastAssistantMessage?: boolean;
    },
  ): Promise<void> {
    if ((options?.allowSessionRouting ?? true) && await maybeRouteSlackMessageToMappedSession(message)) {
      return;
    }

    const explicitSwitchCommand = isExplicitRemoteSwitchCommand(message);
    if (message.threadId && !explicitSwitchCommand) {
      rememberSlackThreadForSession(message.chatId, message.threadId, undefined, getCurrentSessionFile);
    }

    if (options?.replayLastAssistantMessage) {
      await replayAllAssistantMessagesToSlackThread(toPendingRemoteChat(message));
    }

    if (await handleRemoteCommand(message)) {
      return;
    }

    pendingRemoteChat = toPendingRemoteChat(message);
    await setSlackWorkingReaction(pendingRemoteChat);
    const taggedMessage = `[📱 @${message.username} via Slack]: ${message.content}`;
    if (ctx.isIdle()) {
      pi.sendUserMessage(taggedMessage);
    } else {
      pi.sendUserMessage(taggedMessage, { deliverAs: "followUp" });
    }
  }

  // ── Remote command handler (Slack messages starting with . or / commands) ──

  async function handleRemoteCommand(message: ExternalMessage): Promise<boolean> {
    const trimmed = message.content.trim();
    const lowered = trimmed.toLowerCase();

    if (lowered === "stop") {
      if (ctx.isIdle()) {
        await sendRemoteText(message, "Nothing is currently running.");
      } else {
        await clearSlackWorkingReaction();
        pendingRemoteChat = null;
        ctx.abort();
        await sendRemoteText(message, "🛑 Stopped current response.");
      }
      return true;
    }

    if (trimmed === ".") {
      const commands = pi.getCommands();
      await sendRemoteText(message, buildRemoteCommandList(commands));
      return true;
    }

    if (trimmed.startsWith(".skill")) {
      const match = trimmed.match(/^\.skill\s+([^\s]+)(?:\s+([\s\S]+))?$/);
      if (!match) {
        await sendRemoteText(message, "Usage: `.skill <name> [args]`");
        return true;
      }

      const skillName = match[1];
      const args = match[2]?.trim() ?? "";
      const commandName = `skill:${skillName}`;
      const command = pi.getCommands().find((item) => item.source === "skill" && item.name === commandName);
      if (!command) {
        await sendRemoteText(message, `Unknown skill: ${skillName}. Send \`.\` to list available commands.`);
        return true;
      }

      await forwardRemoteCommandToPi(message, `/${commandName}${args ? ` ${args}` : ""}`);
      return true;
    }

    if (trimmed.startsWith(".prompt")) {
      const match = trimmed.match(/^\.prompt\s+([^\s]+)(?:\s+([\s\S]+))?$/);
      if (!match) {
        await sendRemoteText(message, "Usage: `.prompt <name> [args]`");
        return true;
      }

      const promptName = match[1];
      const args = match[2]?.trim() ?? "";
      const command = pi.getCommands().find((item) => item.source === "prompt" && item.name === promptName);
      if (!command) {
        await sendRemoteText(message, `Unknown prompt: ${promptName}. Send \`.\` to list available commands.`);
        return true;
      }

      await forwardRemoteCommandToPi(message, `/${promptName}${args ? ` ${args}` : ""}`);
      return true;
    }

    if (trimmed.startsWith(".bridge")) {
      const match = trimmed.match(/^\.bridge(?:\s+([^\s]+))?(?:\s+([\s\S]+))?$/);
      const subcommand = match?.[1]?.toLowerCase() ?? "help";
      const rest = match?.[2]?.trim() ?? "";

      switch (subcommand) {
        case "help":
          await sendRemoteText(message, buildBridgeHelpText());
          return true;
        case "status": {
          const stats = auth.getStats();
          await sendRemoteText(message, buildBridgeStatusText(
            slackIsConnected(),
            stats.trustedUser,
            stats.channels,
          ));
          return true;
        }
        case "connect":
          try {
            const cfg = loadConfig();
            cfg.autoConnect = true;
            saveConfig(cfg);
            await connectCurrentSession({ showTakeoverNotice: true, handoverReason: "user-request" });
            await sendRemoteText(message, "✅ Connected to Slack");
          } catch (err) {
            await sendRemoteText(message, `❌ Connection failed: ${(err as Error).message}`);
          }
          return true;
        case "disconnect":
          await disconnectCurrentSession();
          await sendRemoteText(message, "🔌 Disconnected from Slack");
          return true;
        case "new":
          try {
            const summary = await startFreshBridgeSession(rest || undefined);
            await sendRemoteText(message, summary);
          } catch (err) {
            await sendRemoteText(message, `❌ Failed to start fresh bridge session: ${(err as Error).message}`);
          }
          return true;
        case "list-sessions":
        case "listsessions":
        case "list-session":
        case "listsession": {
          const limit = rest ? parseInt(rest, 10) : 10;
          if (!Number.isFinite(limit) || limit < 1) {
            await sendRemoteText(message, "Usage: `.bridge list-sessions [number]`");
            return true;
          }
          await sendRemoteText(message, await buildSessionListText(limit));
          return true;
        }
        case "switch": {
          const index = parseInt(rest, 10);
          if (!Number.isFinite(index) || index < 1) {
            await sendRemoteText(message, "Usage: `.bridge switch <number>`");
            return true;
          }
          try {
            const summary = await switchToListedBridgeSession(index);
            await sendRemoteText(message, summary);
          } catch (err) {
            await sendRemoteText(message, `❌ Failed to switch session: ${(err as Error).message}`);
          }
          return true;
        }
        case "sendfile":
          if (!rest) {
            await sendRemoteText(message, "Usage: `.bridge sendfile <path>`");
            return true;
          }
          try {
            const filePath = await sendSlackFileToCurrentChat(rest, undefined, toPendingRemoteChat(message));
            await sendRemoteText(message, `📎 Uploaded ${path.basename(filePath)} to current Slack chat`);
          } catch (err) {
            await sendRemoteText(message, `❌ File upload failed: ${(err as Error).message}`);
          }
          return true;
        case "replay": {
          const conversation = getConversationHistory(ctx.sessionManager);
          if (conversation.length === 0) {
            return true;
          }
          const threadTs = await sendToRemoteChat(message.chatId, "🔄 **Session Replay**", {
            threadId: message.threadId,
            forceTopLevel: !message.threadId,
          });
          if (!threadTs) {
            return true;
          }
          for (const entry of conversation) {
            const text = entry.role === "user"
              ? `🗣️ **User:** ${entry.text}`
              : entry.text;
            await sendToRemoteChat(message.chatId, text, { threadId: threadTs });
          }
          markLatestAssistantDeliveredToSlackThread(
            message.chatId,
            threadTs,
            undefined,
            getCurrentSessionFile,
            () => getLastAssistantMessageInfo(ctx.sessionManager),
          );
          return true;
        }
        default:
          await sendRemoteText(message, `Unknown bridge command: ${subcommand}`);
          return true;
      }
    }

    return false;
  }

  // ── Widget ───────────────────────────────────────────────────────────────

  function updateWidget(): void {
    const config = loadConfig();

    if (config.showWidget === false) {
      ctx.ui.setStatus("slk-bridge-status", undefined);
      return;
    }

    const statusText = createStatusWidget(
      { connected: slackIsConnected() },
      { slack: [] },
    );
    if (statusText) {
      ctx.ui.setStatus("slk-bridge-status", statusText);
    } else {
      ctx.ui.setStatus("slk-bridge-status", undefined);
    }
  }

  function saveAuthState(): void {
    const config = loadConfig();
    config.auth = auth.exportConfig();
    saveConfig(config);
  }

  // ── Register tool ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "send_slack_file",
    label: "Send Slack File",
    description: "Upload a local file to the current Slack conversation",
    promptSnippet: "Upload a local file to the active Slack chat",
    promptGuidelines: [
      "Use send_slack_file when the user explicitly asks to receive a file in Slack and the file already exists locally.",
      "Prefer normal text replies unless the user asked for a file or the content is better delivered as a file.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the local file to upload" }),
      title: Type.Optional(Type.String({ description: "Optional title shown in Slack" })),
      initialComment: Type.Optional(Type.String({ description: "Optional comment to post with the file" })),
    }),
    async execute(_toolCallId, params) {
      const filePath = await sendSlackFileToCurrentChat(params.path, {
        title: params.title,
        initialComment: params.initialComment,
      });

      return {
        content: [{ type: "text", text: `Uploaded ${path.basename(filePath)} to the current Slack chat.` }],
        details: {
          chatId: pendingRemoteChat?.chatId,
          path: filePath,
        },
      };
    },
  });

  // ── Wire Slack client message handler ────────────────────────────────────

  function setupSlackMessageHandler(): void {
    if (!slackClient) return;
    slackClient.onMessage((msg: ExternalMessage) => {
      if (!ownsBridgeConnection()) return;

      void handleIncomingRemoteMessage(msg).catch((err: Error) => {
        ctx.ui.notify(`❌ Failed to handle Slack message: ${err.message}`, "error");
      });
    });

    slackClient.onError((err: Error) => {
      ctx.ui.notify(`❌ Slack error: ${err.message}`, "error");
    });
  }

  // ── pi lifecycle hooks ───────────────────────────────────────────────────

  pi.on("session_start", async (_event, context) => {
    ctx = context;

    const config = loadConfig();

    auth = new ChallengeAuth(
      (code, username) => {
        ctx.ui.notify(`🔐 Challenge code for @${username}: ${code}`, "info");
      },
      (message, level) => {
        ctx.ui.notify(message, level);
      },
      async (_chatId, _message) => {
        // Challenge notifications are sent via the Slack client's sendMessage
      },
      saveAuthState,
    );

    if (config.auth) {
      auth.loadFromConfig(config.auth);
    }

    // Initialize Slack client in the background (non-blocking)
    if (config.slack?.botToken && config.slack?.appToken) {
      slackClient = new SlackClient(config.slack, auth);
    }

    // Auto-connect if configured
    if (slackClient && config.autoConnect !== false) {
      if (!acquireLock()) {
        ctx.ui.notify("ℹ️ slk-bridge: another instance is already connected — skipping auto-connect", "info");
      } else {
        try {
          await slackClient.connect();
          updateWidget();
        } catch (err) {
          releaseLock();
          ctx.ui.notify(`⚠️ Slack connection failed: ${(err as Error).message}`, "warning");
        }
      }
    }

    // Wire Slack client message handler inside session_start (ctx is available)
    if (slackClient) {
      slackClient.onMessage((msg: ExternalMessage) => {
        if (!ownsBridgeConnection()) return;

        void handleIncomingRemoteMessage(msg).catch((err: Error) => {
          ctx.ui.notify(`❌ Failed to handle Slack message: ${err.message}`, "error");
        });
      });

      slackClient.onError((err: Error) => {
        ctx.ui.notify(`❌ Slack error: ${err.message}`, "error");
      });
    }

    ownershipTimer = setInterval(() => {
      if (ownershipCheckInProgress || !isLockHeldLocally() || isCurrentLockOwner()) return;
      ownershipCheckInProgress = true;

      void (async () => {
        await clearSlackWorkingReaction();
        if (slackClient) {
          await slackClient.disconnect();
        }
        pendingRemoteChat = null;
        turnAccumulator = null;
        releaseLock();
        updateWidget();
        ctx.ui.notify("🔄 slk-bridge connection moved to another session", "info");
      })()
        .catch((err) => {
          ctx.ui.notify(`❌ Failed to release slk-bridge connection after ownership loss: ${(err as Error).message}`, "error");
        })
        .finally(() => {
          ownershipCheckInProgress = false;
        });
    }, 250);

    updateWidget();
  });

  pi.on("input", async (event, _context) => {
    if (event.source !== "interactive" && event.source !== "rpc") {
      return;
    }

    const sessionFile = getCurrentSessionFile();
    if (sessionFile) {
      const config = loadConfig();
      if (config.optedOutSessions?.includes(sessionFile)) {
        return;
      }
    }

    try {
      await connectCurrentSession({ respectAutoConnect: true, handoverReason: "active-session" });
    } catch (err) {
      ctx.ui.notify(
        `⚠️ slk-bridge could not move to this active session: ${(err as Error).message}`,
        "warning",
      );
    }
  });

  pi.on("turn_start", async (_event, _context) => {
    if (pendingRemoteChat && ownsBridgeConnection()) {
      try {
        await setSlackWorkingReaction(pendingRemoteChat);
      } catch {
        // Ignore reaction errors
      }
    }
  });

  /**
   * turn_end → accumulate response text into a buffer.
   *
   * Strategy: instead of sending each turn incrementally to Slack (which creates
   * many small messages), we buffer all turns and flush them as one batch on
   * agent_end. This gives cleaner Slack output.
   */
  pi.on("turn_end", async (event, _context) => {
    if (!pendingRemoteChat || !ownsBridgeConnection()) {
      if (!ownsBridgeConnection()) {
        pendingRemoteChat = null;
      }
      return;
    }

    try {
      const message = event.message as AssistantMessage;
      const responseText = extractTextFromMessage(message);
      const toolCallsText = formatToolCalls(message);
      const config = loadConfig();

      const parts: string[] = [];
      const trimmedResponse = responseText.trim();
      if (trimmedResponse) parts.push(trimmedResponse);
      if (toolCallsText && !config.hideToolCalls) parts.push(toolCallsText);

      if (parts.length === 0) {
        return;
      }

      if (!turnAccumulator) {
        turnAccumulator = {
          chatId: pendingRemoteChat.chatId,
          entries: [],
          threadId: pendingRemoteChat.threadId,
        };
      }

      turnAccumulator.entries.push(parts.join("\n\n"));
    } catch (err) {
      ctx.ui.notify(`Failed to accumulate turn response: ${(err as Error).message}`, "error");
    }
  });

  /**
   * agent_end → flush all accumulated turn messages to Slack.
   *
   * Each accumulated entry becomes a separate Slack message. Only the last
   * entry gets the footer (model info, context usage, etc.). Then clear the
   * working reaction so the user knows we're done.
   */
  pi.on("agent_end", async (_event, _context) => {
    if (!turnAccumulator || !ownsBridgeConnection()) {
      turnAccumulator = null;
      return;
    }

    try {
      const totalEntries = turnAccumulator.entries.length;
      let lastSlackThreadId = turnAccumulator.threadId;

      for (let ei = 0; ei < totalEntries; ei++) {
        const isLast = ei === totalEntries - 1;
        const entry = turnAccumulator.entries[ei];
        const resolvedThreadId = await sendToRemoteChat(
          turnAccumulator.chatId,
          entry,
          {
            threadId: turnAccumulator.threadId,
            noFooter: !isLast,
          },
        );
        if (resolvedThreadId) {
          lastSlackThreadId = resolvedThreadId;
        }
      }

      if (lastSlackThreadId) {
        markLatestAssistantDeliveredToSlackThread(
          turnAccumulator.chatId,
          lastSlackThreadId,
          undefined,
          getCurrentSessionFile,
          () => getLastAssistantMessageInfo(ctx.sessionManager),
        );
      }
    } catch (err) {
      ctx.ui.notify(`Failed to send accumulated response: ${(err as Error).message}`, "error");
    } finally {
      await clearSlackWorkingReaction();
      pendingRemoteChat = null;
      turnAccumulator = null;
    }
  });

  pi.on("session_shutdown", async (_event, _context) => {
    if (ownershipTimer) {
      clearInterval(ownershipTimer);
      ownershipTimer = undefined;
    }
    await clearSlackWorkingReaction();
    turnAccumulator = null;
    if (slackClient) {
      await slackClient.disconnect();
    }
    releaseLock();
  });

  // ── /slk-bridge command (TUI local) ────────────────────────────────────────

  pi.registerCommand("slk-bridge", {
    description: "Manage Slack bridge connection (help|status|connect|disconnect|configure|widget|new|list-sessions|switch)",
    handler: async (args: string, context) => {
      const parts = args.trim().split(/\s+/).filter((p) => p.length > 0);
      const subcommand = parts[0] || "";

      // No subcommand → open interactive menu
      if (!subcommand || subcommand === "menu") {
        await openMainMenu({
          ui: context.ui,
          reconnect: async () => {
            const cfg = loadConfig();
            slackClient = new SlackClient(cfg.slack!, auth);
            if (acquireLock()) {
              try {
                await slackClient.connect();
                setupSlackMessageHandler();
                updateWidget();
              } catch (err) {
                releaseLock();
                throw err;
              }
            }
          },
          disconnect: async () => {
            if (slackClient) {
              await slackClient.disconnect();
            }
            releaseLock();
            const cfg = loadConfig();
            cfg.autoConnect = false;
            saveConfig(cfg);
            updateWidget();
          },
          toggleWidget: () => {
            const cfg = loadConfig();
            cfg.showWidget = cfg.showWidget === false;
            saveConfig(cfg);
            const state = cfg.showWidget !== false ? "shown" : "hidden";
            context.ui.notify(`📊 Status widget ${state}`, "info");
            updateWidget();
          },
          optOut: () => {
            const sessionFile = getCurrentSessionFile();
            if (!sessionFile) {
              context.ui.notify("❌ No session file available for this session", "error");
              return;
            }
            const cfg = loadConfig();
            const optedOut = cfg.optedOutSessions ?? [];
            if (optedOut.includes(sessionFile)) {
              context.ui.notify("ℹ️ This session is already opted out of bridge takeover", "info");
              return;
            }
            optedOut.push(sessionFile);
            cfg.optedOutSessions = optedOut;
            saveConfig(cfg);
            context.ui.notify("🛑 This session will NOT take over the Slack bridge when active", "info");
          },
          optIn: () => {
            const sessionFile = getCurrentSessionFile();
            if (!sessionFile) {
              context.ui.notify("❌ No session file available for this session", "error");
              return;
            }
            const cfg = loadConfig();
            const optedOut = cfg.optedOutSessions ?? [];
            const idx = optedOut.indexOf(sessionFile);
            if (idx === -1) {
              context.ui.notify("ℹ️ This session was not opted out — nothing to do", "info");
              return;
            }
            optedOut.splice(idx, 1);
            cfg.optedOutSessions = optedOut.length > 0 ? optedOut : undefined;
            saveConfig(cfg);
            context.ui.notify("✅ This session can now take over the Slack bridge again", "info");
          },
          getStatusLine: () => {
            const connected = slackClient?.isConnected ?? false;
            const stats = auth.getStats();
            const statusLine = connected
              ? "  ● Connected"
              : "  ○ Disconnected";
            return `${statusLine}\n  Trusted user: ${stats.trustedUser ?? "None"}`;
          },
        });
        return;
      }

      switch (subcommand) {
        case "help":
          context.ui.notify(buildBridgeHelpText(), "info");
          break;

        case "status": {
          const stats = auth.getStats();
          context.ui.notify(
            buildBridgeStatusText(slackIsConnected(), stats.trustedUser, stats.channels),
            "info",
          );
          break;
        }

        case "connect": {
          try {
            const reasonArg = parts[1] === "user-request" || parts[1] === "active-session"
              ? parts[1]
              : "user-request";
            const cfg = loadConfig();
            cfg.autoConnect = true;
            saveConfig(cfg);
            await connectCurrentSession({ showTakeoverNotice: true, handoverReason: reasonArg });
            context.ui.notify("✅ Connected to Slack", "info");
            updateWidget();
          } catch (err) {
            releaseLock();
            context.ui.notify(`❌ Connection failed: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "disconnect": {
          await disconnectCurrentSession();
          context.ui.notify("🔌 Disconnected from Slack", "info");
          break;
        }

        case "configure": {
          const token = parts.slice(1).join(" ");
          const parts2 = token.split(/\s+/);
          const botToken = parts2[0];
          const appToken = parts2[1];

          if (!botToken || !appToken) {
            context.ui.notify("Usage: /slk-bridge configure <bot-token> <app-token>", "error");
            return;
          }

          const config = loadConfig();
          config.slack = { botToken, appToken };
          saveConfig(config);

          slackClient = new SlackClient(config.slack, auth);
          if (acquireLock()) {
            try {
              await slackClient.connect();
              setupSlackMessageHandler();
              context.ui.notify("✅ Slack configured and connected", "info");
            } catch (err) {
              releaseLock();
              context.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
            }
          } else {
            context.ui.notify(
              "✅ Slack configured (another instance is connected — run /slk-bridge connect later)",
              "info",
            );
          }
          updateWidget();
          break;
        }

        case "widget": {
          const cfg = loadConfig();
          cfg.showWidget = cfg.showWidget === false;
          saveConfig(cfg);
          const widgetState = cfg.showWidget !== false ? "shown" : "hidden";
          context.ui.notify(`📊 Status widget ${widgetState}`, "info");
          updateWidget();
          break;
        }

        case "new": {
          const cwdArg = parts.slice(1).join(" ").trim();
          try {
            const summary = await startFreshBridgeSession(cwdArg || undefined);
            context.ui.notify(summary, "info");
          } catch (err) {
            context.ui.notify(`❌ Failed to start fresh bridge session: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "list-sessions":
        case "list-session": {
          const limitArg = parts[1];
          const limit = limitArg ? parseInt(limitArg, 10) : 10;
          if (!Number.isFinite(limit) || limit < 1) {
            context.ui.notify("Usage: /slk-bridge list-sessions [number]", "error");
            break;
          }
          try {
            context.ui.notify(await buildSessionListText(limit), "info");
          } catch (err) {
            context.ui.notify(`❌ Failed to list sessions: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "switch": {
          const index = parseInt(parts[1] || "", 10);
          if (!Number.isFinite(index) || index < 1) {
            context.ui.notify("Usage: /slk-bridge switch <number>", "error");
            break;
          }
          try {
            const summary = await switchToListedBridgeSession(index);
            context.ui.notify(summary, "info");
          } catch (err) {
            context.ui.notify(`❌ Failed to switch session: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "sendfile": {
          const fileArg = parts.slice(1).join(" ").trim();
          if (!fileArg) {
            context.ui.notify("Usage: /slk-bridge sendfile <path>", "error");
            break;
          }
          try {
            const filePath = await sendSlackFileToCurrentChat(fileArg);
            context.ui.notify(`📎 Uploaded ${path.basename(filePath)} to current Slack chat`, "info");
          } catch (err) {
            context.ui.notify(`❌ File upload failed: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "releaseclaim": {
          const removed = auth.releaseClaim();
          context.ui.notify(
            `🔓 Re-opened Slack claim${removed > 0 ? ` (removed ${removed} trusted user${removed === 1 ? "" : "s"})` : ""}`,
            "info",
          );
          break;
        }

        case "optout":
        case "opt-out": {
          const sessionFile = getCurrentSessionFile();
          if (!sessionFile) {
            context.ui.notify("❌ No session file available for this session", "error");
            break;
          }
          const cfg = loadConfig();
          const optedOut = cfg.optedOutSessions ?? [];
          if (optedOut.includes(sessionFile)) {
            context.ui.notify("ℹ️ This session is already opted out of bridge takeover", "info");
            break;
          }
          optedOut.push(sessionFile);
          cfg.optedOutSessions = optedOut;
          saveConfig(cfg);
          context.ui.notify("🛑 This session will NOT take over the Slack bridge when active", "info");
          break;
        }

        case "optin":
        case "opt-in": {
          const sessionFile = getCurrentSessionFile();
          if (!sessionFile) {
            context.ui.notify("❌ No session file available for this session", "error");
            break;
          }
          const cfg = loadConfig();
          const optedOut = cfg.optedOutSessions ?? [];
          const idx = optedOut.indexOf(sessionFile);
          if (idx === -1) {
            context.ui.notify("ℹ️ This session was not opted out — nothing to do", "info");
            break;
          }
          optedOut.splice(idx, 1);
          cfg.optedOutSessions = optedOut.length > 0 ? optedOut : undefined;
          saveConfig(cfg);
          context.ui.notify("✅ This session can now take over the Slack bridge again", "info");
          break;
        }

        case "optout-list":
        case "optout list":
        case "opt-out-list":
        case "opt-out list": {
          const cfg = loadConfig();
          const optedOut = cfg.optedOutSessions ?? [];
          if (optedOut.length === 0) {
            context.ui.notify("📋 No sessions are currently opted out of bridge takeover", "info");
            break;
          }
          const lines = ["📋 Opted-out sessions", ""];
          for (const s of optedOut) {
            lines.push(`  • ${s}`);
          }
          context.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "toggletools": {
          const cfg = loadConfig();
          cfg.hideToolCalls = !cfg.hideToolCalls;
          saveConfig(cfg);
          const toolState = cfg.hideToolCalls ? "hidden" : "shown";
          context.ui.notify(`🔧 Tool calls ${toolState} in remote messages`, "info");
          break;
        }

        case "accept-handoff": {
          const handoffFile = parts.slice(1).join(" ").trim();
          if (!handoffFile) {
            context.ui.notify("Usage: /slk-bridge accept-handoff <file>", "error");
            break;
          }

          try {
            const raw = fs.readFileSync(handoffFile, "utf-8");
            const payload = JSON.parse(raw) as {
              message: Omit<ExternalMessage, "timestamp"> & { timestamp: string };
              replayLastAssistantMessage?: boolean;
            };
            const message: ExternalMessage = {
              ...payload.message,
              timestamp: new Date(payload.message.timestamp),
            };

            await connectCurrentSession({
              showTakeoverNotice: false,
              notifySlackHandover: false,
            });
            await handleIncomingRemoteMessage(message, {
              allowSessionRouting: false,
              replayLastAssistantMessage: payload.replayLastAssistantMessage === true,
            });
          } catch (err) {
            context.ui.notify(`❌ Failed to accept slk-bridge handoff: ${(err as Error).message}`, "error");
          } finally {
            try {
              fs.unlinkSync(handoffFile);
            } catch {
              // Ignore cleanup failures
            }
          }
          break;
        }

        default:
          context.ui.notify(`Unknown subcommand: ${subcommand}. Run /slk-bridge help`, "warning");
          break;
      }
    },
  });
}
