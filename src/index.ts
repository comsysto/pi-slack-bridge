import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Type } from "typebox";
import { ChallengeAuth } from "./auth/challenge-auth.js";
import { loadConfig, saveConfig } from "./config.js";
import { extractTextFromMessage, formatToolCalls, hasToolCalls, splitMessage, truncate } from "./formatting.js";
import { acquireLock, forceAcquireLock, getInstanceId, isCurrentLockOwner, isLockHeldLocally, releaseLock } from "./lock.js";
import { DiscordProvider } from "./transports/discord.js";
import { TransportManager } from "./transports/manager.js";
import { MatrixProvider } from "./transports/matrix.js";
import { SlackProvider } from "./transports/slack.js";
import { TelegramProvider } from "./transports/telegram.js";
import { WhatsAppProvider } from "./transports/whatsapp.js";
import type { PendingRemoteChat, TransportStatus } from "./types.js";
import { openMainMenu } from "./ui/main-menu.js";
import { createStatusWidget } from "./ui/status-widget.js";

/**
 * pi-remote-pilot extension
 * Bridges messenger apps (Telegram, WhatsApp, Slack, Discord) into pi
 */
export default function (pi: ExtensionAPI): void {
  const transportManager = new TransportManager();
  let pendingRemoteChat: PendingRemoteChat | null = null;
  let auth: ChallengeAuth;
  let ctx: ExtensionContext;
  let ownershipTimer: NodeJS.Timeout | undefined;
  let ownershipCheckInProgress = false;
  let transportInitialization: Promise<void> = Promise.resolve();

  function ownsBridgeConnection(): boolean {
    return isLockHeldLocally() && isCurrentLockOwner();
  }

  function hasConfiguredTransports(): boolean {
    return transportManager.getAllTransports().length > 0;
  }

  function allConfiguredTransportsConnected(): boolean {
    const status = transportManager.getStatus();
    return status.length > 0 && status.every((s) => s.connected);
  }

  function getFirstSessionPrompt(): string {
    const branch = ctx.sessionManager.getBranch();
    const firstUserMessage = branch.find(
      (entry: any) => entry.type === "message" && entry.message?.role === "user"
    ) as any;

    if (!firstUserMessage?.message?.content) {
      return "No user prompt yet";
    }

    const text = firstUserMessage.message.content
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n")
      .trim();

    return text ? truncate(text, 500) : "No text prompt yet";
  }

  function formatContextUsage(): string {
    const usage = ctx.getContextUsage();
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;

    if (!usage || !contextWindow) {
      return "Unknown";
    }

    const percent = usage.percent === null ? "?" : `${Math.round(usage.percent)}%`;
    const tokens = usage.tokens === null ? "?" : usage.tokens.toLocaleString();
    return `${tokens} / ${contextWindow.toLocaleString()} tokens (${percent})`;
  }

  function getLastAssistantMessageText(): string | null {
    const branch = ctx.sessionManager.getBranch();

    for (let i = branch.length - 1; i >= 0; i--) {
      const entry: any = branch[i];
      if (entry.type !== "message") continue;
      if (entry.message?.role !== "assistant") continue;
      if (entry.message?.stopReason && entry.message.stopReason !== "stop") continue;

      const text = extractTextFromMessage(entry.message as AssistantMessage).trim();
      if (text) {
        return text;
      }
    }

    return null;
  }

  async function sendSlackFileToCurrentChat(filePathInput: string, options?: {
    title?: string;
    initialComment?: string;
  }): Promise<string> {
    if (!pendingRemoteChat || !ownsBridgeConnection()) {
      throw new Error("No active remote chat is available for file upload");
    }
    if (pendingRemoteChat.transport !== "slack") {
      throw new Error("File upload is currently only supported for Slack chats");
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

    await transportManager.sendFile(
      pendingRemoteChat.chatId,
      "slack",
      filePath,
      {
        title: options?.title,
        initialComment: options?.initialComment,
      },
    );

    return filePath;
  }

  async function notifySlackSessionHandover(): Promise<void> {
    const slackChats = auth.getNotificationChatIds("slack");
    if (slackChats.length === 0) {
      return;
    }

    const handoverMessage = [
      "🔄 Session changed",
      `- Working directory: \`${ctx.cwd}\``,
      `- First prompt: ${getFirstSessionPrompt()}`,
      `- Context window: ${formatContextUsage()}`,
    ].join("\n");

    const lastAssistantMessage = getLastAssistantMessageText();
    const lastAssistantChunks = lastAssistantMessage
      ? splitMessage(lastAssistantMessage, 12000)
      : [];

    for (const chatId of slackChats) {
      try {
        await transportManager.sendMessage(chatId, "slack", handoverMessage);

        for (let i = 0; i < lastAssistantChunks.length; i++) {
          const prefix = i === 0 ? "🧵 Last agent message\n\n" : "";
          await transportManager.sendMessage(chatId, "slack", `${prefix}${lastAssistantChunks[i]}`);
        }
      } catch (_err) {
        // Ignore notification failures to avoid breaking takeover flow
      }
    }
  }

  async function connectCurrentSession(options?: {
    respectAutoConnect?: boolean;
    showTakeoverNotice?: boolean;
  }): Promise<boolean> {
    await transportInitialization;

    const config = loadConfig();
    if ((options?.respectAutoConnect ?? false) && config.autoConnect === false) {
      return false;
    }
    if (!hasConfiguredTransports()) {
      return false;
    }

    const alreadyOwner = ownsBridgeConnection();
    const previousOwner = alreadyOwner ? null : forceAcquireLock();
    const tookOver = !!previousOwner && (previousOwner.pid !== process.pid || previousOwner.owner !== getInstanceId());

    if (options?.showTakeoverNotice && tookOver) {
      ctx.ui.notify("🔄 Taking over msg-bridge connection from another session...", "info");
    }

    if (alreadyOwner && allConfiguredTransportsConnected()) {
      return false;
    }

    if (tookOver) {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    try {
      await transportManager.connectAll();
      updateWidget();
      if (tookOver) {
        await notifySlackSessionHandover();
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

  pi.registerTool({
    name: "send_slack_file",
    label: "Send Slack File",
    description: "Upload a local file to the current Slack conversation",
    promptSnippet: "Upload a local file to the active Slack chat",
    promptGuidelines: [
      "Use send_slack_file when the user explicitly asks to receive a file in Slack and the file already exists locally.",
      "Prefer normal text replies unless the user asked for a file or the content is better delivered as a file."
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
          transport: "slack",
          chatId: pendingRemoteChat?.chatId,
          path: filePath,
        },
      };
    },
  });

  /**
   * Update status widget
   */
  function updateWidget(): void {
    const config = loadConfig();

    if (config.showWidget === false) {
      ctx.ui.setWidget("msg-bridge-status", undefined);
      return;
    }

    const stats = auth.getStats();
    const transports: TransportStatus[] = transportManager
      .getStatus()
      .map((s) => ({
        type: s.type,
        connected: s.connected,
      }));

    const widget = createStatusWidget(transports, stats.usersByTransport);
    if (widget) {
      ctx.ui.setWidget("msg-bridge-status", [widget]);
    } else {
      ctx.ui.setWidget("msg-bridge-status", undefined);
    }
  }

  /**
   * Save auth state to config
   */
  function saveAuthState(): void {
    const config = loadConfig();
    config.auth = auth.exportConfig();
    saveConfig(config);
  }

  /**
   * Initialize extension
   */
  pi.on("session_start", async (_event, context) => {
    ctx = context;

    const config = loadConfig();

    auth = new ChallengeAuth(
      (code, username) => {
        ctx.ui.notify(
          `🔐 Challenge code for @${username}: ${code}`,
          "info"
        );
      },
      (message, level) => {
        ctx.ui.notify(message, level);
      },
      async (_chatId, _message) => {
        // Challenge notifications are sent via the transport's sendMessage
      },
      saveAuthState
    );

    if (config.auth) {
      auth.loadFromConfig(config.auth);
    }

    // Initialize transports in the background (non-blocking)
    transportInitialization = (async () => {
      const transportPromises: Promise<void>[] = [];

      if (config.telegram?.token) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const telegramProvider = new TelegramProvider(config.telegram!.token, auth);
            transportManager.addTransport(telegramProvider);
          })
        );
      }

      if (config.whatsapp) {
        const whatsappAuthPath = config.whatsapp.authPath || path.join(
          os.homedir(),
          ".pi",
          "msg-bridge-whatsapp-auth"
        );

        const credsPath = path.join(whatsappAuthPath, "creds.json");
        if (fs.existsSync(credsPath)) {
          transportPromises.push(
            Promise.resolve().then(() => {
              const whatsappConfig = { ...config.whatsapp!, debug: config.debug };
              const whatsappProvider = new WhatsAppProvider(whatsappConfig, auth);
              transportManager.addTransport(whatsappProvider);
            })
          );
        } else {
          delete config.whatsapp;
          saveConfig(config);
        }
      }

      if (config.slack?.botToken && config.slack?.appToken) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const slackProvider = new SlackProvider(config.slack!, auth);
            transportManager.addTransport(slackProvider);
          })
        );
      }

      if (config.discord?.token) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const discordProvider = new DiscordProvider(config.discord!, auth);
            transportManager.addTransport(discordProvider);
          })
        );
      }

      if (config.matrix?.homeserverUrl && config.matrix?.accessToken) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const matrixProvider = new MatrixProvider(config.matrix!, auth);
            transportManager.addTransport(matrixProvider);
          })
        );
      }

      await Promise.all(transportPromises);

      // Auto-connect if configured
      const transports = transportManager.getAllTransports();
      if (transports.length > 0 && config.autoConnect !== false) {
        if (!acquireLock()) {
          ctx.ui.notify("ℹ️ msg-bridge: another instance is already connected — skipping auto-connect", "info");
        } else {
          try {
            await transportManager.connectAll();
            updateWidget();
          } catch (err) {
            releaseLock();
            ctx.ui.notify(`⚠️ Some transports failed to connect: ${(err as Error).message}`, "warning");
          }
        }
      }
    })().catch(err => {
      throw err;
    });

    void transportInitialization.catch(err => {
      console.error("Transport initialization error:", err);
      ctx.ui.notify(`❌ Transport initialization failed: ${err.message}`, "error");
    });

    transportManager.onMessage((msg) => {
      if (!ownsBridgeConnection()) {
        return;
      }

      pendingRemoteChat = {
        chatId: msg.chatId,
        transport: msg.transport,
        username: msg.username,
        messageId: msg.messageId,
      };

      const taggedMessage = `[📱 @${msg.username} via ${msg.transport}]: ${msg.content}`;
      pi.sendUserMessage(taggedMessage, { deliverAs: "followUp" });
    });

    transportManager.onError((err, transport) => {
      ctx.ui.notify(`❌ ${transport} error: ${err.message}`, "error");
    });

    ownershipTimer = setInterval(() => {
      if (ownershipCheckInProgress || !isLockHeldLocally() || isCurrentLockOwner()) return;
      ownershipCheckInProgress = true;

      void (async () => {
        await transportManager.disconnectAll();
        pendingRemoteChat = null;
        releaseLock();
        updateWidget();
        ctx.ui.notify("🔄 msg-bridge connection moved to another session", "info");
      })().catch((err) => {
        ctx.ui.notify(`❌ Failed to release msg-bridge connection after ownership loss: ${(err as Error).message}`, "error");
      }).finally(() => {
        ownershipCheckInProgress = false;
      });
    }, 250);

    updateWidget();
  });

  pi.on("input", async (event, _context) => {
    if (event.source !== "interactive" && event.source !== "rpc") {
      return;
    }

    try {
      await connectCurrentSession({ respectAutoConnect: true });
    } catch (err) {
      ctx.ui.notify(
        `⚠️ msg-bridge could not move to this active session: ${(err as Error).message}`,
        "warning"
      );
    }
  });

  /**
   * Handle turn start - send typing indicator
   */
  pi.on("turn_start", async (_event, _context) => {
    if (pendingRemoteChat && ownsBridgeConnection()) {
      try {
        await transportManager.sendTyping(
          pendingRemoteChat.chatId,
          pendingRemoteChat.transport
        );
      } catch (_err) {
        // Ignore typing indicator errors
      }
    }
  });

  /**
   * Handle turn end - send response back to messenger
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
      const hasPendingTools = hasToolCalls(message);
      const config = loadConfig();

      const parts: string[] = [];
      const trimmedResponse = responseText.trim();
      if (trimmedResponse) parts.push(trimmedResponse);
      if (toolCallsText && !config.hideToolCalls) parts.push(toolCallsText);

      if (parts.length === 0) {
        // Nothing to send this turn — don't touch pendingRemoteChat;
        // a future turn_end may have the actual response text.
        return;
      }

      const fullText = parts.join("\n\n");

      // Split long messages — use transport-appropriate limits
      const maxChunkLen = pendingRemoteChat.transport === "slack" ? 12000 : 4000;
      const chunks = splitMessage(fullText, maxChunkLen);
      for (const chunk of chunks) {
        await transportManager.sendMessage(
          pendingRemoteChat.chatId,
          pendingRemoteChat.transport,
          chunk
        );
      }

      if (!hasPendingTools) {
        pendingRemoteChat = null;
      }
    } catch (err) {
      const transport = pendingRemoteChat?.transport ?? "unknown";
      ctx.ui.notify(
        `Failed to send response to ${transport}: ${(err as Error).message}`,
        "error"
      );
      pendingRemoteChat = null;
    }
  });

  /**
   * Cleanup on session exit — release lock and disconnect transports
   */
  pi.on("session_shutdown", async (_event, _context) => {
    if (ownershipTimer) {
      clearInterval(ownershipTimer);
      ownershipTimer = undefined;
    }
    await transportManager.disconnectAll();
    releaseLock();
  });

  /**
   * /msg-bridge command - show status or manage connections
   */
  pi.registerCommand("msg-bridge", {
    description: "Manage remote messenger connections (help|status|connect|disconnect|configure|widget)",
    handler: async (args: string, context) => {
      const parts = args.trim().split(/\s+/).filter(p => p.length > 0);
      const subcommand = parts[0] || "";

    // No subcommand → open interactive menu
    if (!subcommand || subcommand === "menu") {
      await openMainMenu({
        ui: context.ui,
        transportManager,
        auth,
        updateWidget,
        connectCurrentSession: async () => {
          const cfg = loadConfig();
          cfg.autoConnect = true;
          saveConfig(cfg);
          await connectCurrentSession({ showTakeoverNotice: true });
        },
      });
      return;
    }

    switch (subcommand) {
      case "help": {
        const helpText = [
          "━━━ Message Bridge Commands ━━━",
          "",
          "/msg-bridge                   Open interactive menu",
          "/msg-bridge help              Show this help",
          "/msg-bridge status            Show connection and user status",
          "/msg-bridge connect           Connect to all transports",
          "/msg-bridge disconnect        Disconnect from all transports",
          "/msg-bridge configure telegram <token>",
          "                              Configure Telegram bot",
          "/msg-bridge configure whatsapp",
          "                              Configure WhatsApp (scan QR)",
          "/msg-bridge configure matrix <homeserver-url> <access-token>",
          "                              Configure Matrix (Element X, etc)",
          "/msg-bridge widget            Toggle status widget on/off",
          "/msg-bridge sendfile <path>   Upload a local file to current Slack chat",
          "/msg-bridge toggletools       Toggle tool call visibility",
          "",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ];
        context.ui.notify(helpText.join("\n"), "info");
        break;
      }
      case "connect": {
        try {
          const cfg = loadConfig();
          cfg.autoConnect = true;
          saveConfig(cfg);
          await connectCurrentSession({ showTakeoverNotice: true });
          context.ui.notify("✅ Connected to all configured transports", "info");
          updateWidget();
        } catch (err) {
          releaseLock();
          context.ui.notify(
            `❌ Connection failed: ${(err as Error).message}`,
            "error"
          );
        }
        break;
      }

      case "disconnect": {
        await transportManager.disconnectAll();
        releaseLock();
        const cfg = loadConfig();
        cfg.autoConnect = false;
        saveConfig(cfg);
        context.ui.notify("🔌 Disconnected from all transports", "info");
        updateWidget();
        break;
      }

      case "configure": {
        const platform = parts[1];
        const token = parts.slice(2).join(" ");

        if (!platform) {
          context.ui.notify("Usage: /msg-bridge configure <platform> [token/path]", "error");
          return;
        }

        const config = loadConfig();

        switch (platform.toLowerCase()) {
          case "telegram": {
            if (!token) {
              context.ui.notify("Usage: /msg-bridge configure telegram <bot-token>", "error");
              return;
            }
            config.telegram = { token };
            saveConfig(config);
            const telegramProvider = new TelegramProvider(token, auth);
            transportManager.addTransport(telegramProvider);
            if (acquireLock()) {
              try {
                await telegramProvider.connect();
                context.ui.notify("✅ Telegram configured and connected", "info");
              } catch (_err) {
                releaseLock();
                context.ui.notify("✅ Telegram configured (run /msg-bridge connect to activate)", "info");
              }
            } else {
              context.ui.notify("✅ Telegram configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "whatsapp": {
            config.whatsapp = token ? { authPath: token } : {};
            saveConfig(config);
            const whatsappConfig = { ...config.whatsapp, debug: config.debug };
            const whatsappProvider = new WhatsAppProvider(whatsappConfig, auth);
            transportManager.addTransport(whatsappProvider);
            if (acquireLock()) {
              try {
                await whatsappProvider.connect(true);
                context.ui.notify("✅ WhatsApp configured and connecting (scan QR code in terminal)...", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ WhatsApp setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ WhatsApp configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "slack": {
            const parts2 = token.split(/\s+/);
            const botToken = parts2[0];
            const appToken = parts2[1];

            if (!botToken || !appToken) {
              context.ui.notify("Usage: /msg-bridge configure slack <bot-token> <app-token>", "error");
              return;
            }

            config.slack = { botToken, appToken };
            saveConfig(config);
            const slackProvider = new SlackProvider(config.slack, auth);
            transportManager.addTransport(slackProvider);
            if (acquireLock()) {
              try {
                await slackProvider.connect();
                context.ui.notify("✅ Slack configured and connected", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ Slack configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "discord": {
            if (!token) {
              context.ui.notify("Usage: /msg-bridge configure discord <bot-token>", "error");
              return;
            }

            config.discord = { token };
            saveConfig(config);
            const discordProvider = new DiscordProvider(config.discord, auth);
            transportManager.addTransport(discordProvider);
            if (acquireLock()) {
              try {
                await discordProvider.connect();
                context.ui.notify("✅ Discord configured and connected", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ Discord setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ Discord configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          case "matrix": {
            const matrixParts = token.split(/\s+/);
            const homeserverUrl = matrixParts[0];
            const matrixAccessToken = matrixParts.slice(1).join(" ");
            if (!homeserverUrl || !matrixAccessToken) {
              context.ui.notify("Usage: /msg-bridge configure matrix <homeserver-url> <access-token>", "error");
              return;
            }

            config.matrix = { homeserverUrl, accessToken: matrixAccessToken };
            saveConfig(config);
            const matrixProvider = new MatrixProvider(config.matrix, auth);
            transportManager.addTransport(matrixProvider);
            if (acquireLock()) {
              try {
                await matrixProvider.connect();
                context.ui.notify("✅ Matrix configured and connected", "info");
              } catch (err) {
                releaseLock();
                context.ui.notify(`⚠️ Matrix setup error: ${(err as Error).message}`, "error");
              }
            } else {
              context.ui.notify("✅ Matrix configured (another instance is connected — run /msg-bridge connect later)", "info");
            }
            updateWidget();
            break;
          }

          default:
            context.ui.notify(`❌ Unknown platform: ${platform}`, "error");
        }
        break;
      }

      case "widget": {
        const cfg2 = loadConfig();
        cfg2.showWidget = cfg2.showWidget === false;
        saveConfig(cfg2);
        const widgetState = cfg2.showWidget !== false ? "shown" : "hidden";
        context.ui.notify(`📊 Status widget ${widgetState}`, "info");
        updateWidget();
        break;
      }

      case "sendfile": {
        const fileArg = parts.slice(1).join(" ").trim();
        if (!fileArg) {
          context.ui.notify("Usage: /msg-bridge sendfile <path>", "error");
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

      case "status": {
        const stats = auth.getStats();
        const status = transportManager.getStatus();
        const lines = [
          "━━━ Message Bridge Status ━━━",
          "",
          "Transports:",
          ...status.map(
            (s) => `  ${s.connected ? "●" : "○"} ${s.type}`
          ),
          "",
          `Trusted Users: ${stats.trustedUsers}`,
        ];

        if (stats.trustedUsers > 0) {
          for (const [transport, userIds] of Object.entries(stats.usersByTransport)) {
            if (userIds.length > 0) {
              lines.push(`  └─ ${transport}: ${userIds.join(", ")}`);
            }
          }
        }

        lines.push("");
        lines.push(`Channels: ${stats.channels}`);
        lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        context.ui.notify(lines.join("\n"), "info");
        break;
      }

      case "toggletools": {
        const cfg3 = loadConfig();
        cfg3.hideToolCalls = !cfg3.hideToolCalls;
        saveConfig(cfg3);
        const toolState = cfg3.hideToolCalls ? "hidden" : "shown";
        context.ui.notify(`🔧 Tool calls ${toolState} in remote messages`, "info");
        break;
      }
      default:
        context.ui.notify(`Unknown subcommand: ${subcommand}. Run /msg-bridge help`, "warning");
        break;
    }
    },
  });
}
