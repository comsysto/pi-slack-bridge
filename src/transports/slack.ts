import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ChallengeAuth } from "../auth/challenge-auth.js";
import { markdownToBlocks, splitMarkdownIntoMessages } from "../slack-blocks.js";
import type { ExternalMessage } from "../types.js";
import type { ITransportProvider, TransportFileOptions } from "./interface.js";

// Dynamic import for ESM modules
type App = any;

const SLACK_DOWNLOAD_DIR = path.join(os.homedir(), ".pi", "msg-bridge-downloads", "slack");

function ensureSlackDownloadDir(): void {
  if (!fs.existsSync(SLACK_DOWNLOAD_DIR)) {
    fs.mkdirSync(SLACK_DOWNLOAD_DIR, { recursive: true, mode: 0o700 });
  }
}

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename || "file");
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

async function loadSlackBolt() {
  const slack = await import("@slack/bolt");
  return slack;
}

/**
 * Slack transport provider using @slack/bolt
 */
export class SlackProvider implements ITransportProvider {
  readonly type = "slack";
  private app: App | null = null;
  private _isConnected = false;
  private botUserId: string = "";
  private messageHandler?: (message: ExternalMessage) => void;
  private errorHandler?: (error: Error) => void;
  private lastProcessedMessageId = "";

  // Cache user info to avoid repeated API calls
  private userCache: Map<string, string> = new Map();
  // Cache channel info to detect DMs vs channels
  private channelCache: Map<string, { isDM: boolean; name?: string }> = new Map();

  constructor(
    private config: { botToken: string; appToken: string },
    private auth: ChallengeAuth
  ) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  private async downloadSlackFile(file: any): Promise<string> {
    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      throw new Error(`Slack file ${file.id || file.name || "unknown"} has no download URL`);
    }

    ensureSlackDownloadDir();
    const filename = sanitizeFilename(file.name || file.title || file.id || "file");
    const targetPath = path.join(
      SLACK_DOWNLOAD_DIR,
      `${Date.now()}-${file.id || "file"}-${filename}`,
    );

    const response = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Slack file download failed (${response.status} ${response.statusText})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(targetPath, buffer, { mode: 0o600 });
    return targetPath;
  }

  private async buildIncomingContent(message: any): Promise<string | null> {
    const text = typeof message.text === "string" ? message.text.trim() : "";

    if (message.subtype === "file_share" && Array.isArray(message.files) && message.files.length > 0) {
      const fileLines: string[] = [];

      for (const file of message.files) {
        const savedPath = await this.downloadSlackFile(file);
        const size = typeof file.size === "number" ? `${file.size.toLocaleString()} bytes` : "size unknown";
        const mimetype = file.mimetype || file.filetype || "unknown type";
        fileLines.push(
          `- ${file.name || file.title || file.id} (${mimetype}, ${size})\n  Saved to: ${savedPath}`,
        );
      }

      const parts = [
        `uploaded ${message.files.length === 1 ? "a file" : `${message.files.length} files`}:`,
        ...fileLines,
      ];

      if (text) {
        parts.push(`Comment: ${text}`);
      }

      return parts.join("\n");
    }

    return text || null;
  }

  async connect(): Promise<void> {
    if (this._isConnected) return;

    const { botToken, appToken } = this.config;

    if (!botToken || !appToken) {
      throw new Error("Slack requires both botToken (xoxb-...) and appToken (xapp-...)");
    }

    const slack = await loadSlackBolt();

    this.app = new slack.App({
      token: botToken,
      appToken: appToken,
      socketMode: true,
      logLevel: slack.LogLevel.ERROR,
    });

    // Get bot's own user ID for mention detection
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id || "";
    } catch (e) {
      if (this.errorHandler) {
        this.errorHandler(new Error(`Slack bot info lookup failed: ${(e as Error).message}`));
      }
    }

    // Listen for all messages
    this.app.message(async ({ message, client }: any) => {
      // Skip bot messages, message edits, deletes, etc. but allow file shares.
      if (message.subtype && message.subtype !== "file_share") {
        return;
      }

      if (!("user" in message) || !("channel" in message) || !("ts" in message)) {
        return;
      }

      const userId = message.user;
      const channelId = message.channel;
      const ts = message.ts;

      const content = await this.buildIncomingContent(message);
      if (!content) {
        return;
      }

      // Filter out duplicate messages
      if (ts === this.lastProcessedMessageId) {
        return;
      }
      this.lastProcessedMessageId = ts;

      // Get username from cache or fetch
      let username: string = this.userCache.get(userId) || userId;
      if (!this.userCache.has(userId)) {
        try {
          const userInfo = await client.users.info({ user: userId });
          const fetchedName = userInfo.user?.real_name || userInfo.user?.name;
          if (fetchedName) {
            username = fetchedName;
            this.userCache.set(userId, username);
          }
        } catch {
          username = userId;
        }
      }

      // Get channel info from cache or fetch (to detect DM vs channel)
      let channelInfo = this.channelCache.get(channelId);
      if (!channelInfo) {
        try {
          const convInfo = await client.conversations.info({ channel: channelId });
          const conv = convInfo.channel;
          // is_im = direct message, is_mpim = multi-party DM
          const isDM = conv?.is_im === true || conv?.is_mpim === true;
          const name = conv?.name || (isDM ? "DM" : channelId);
          channelInfo = { isDM, name };
          this.channelCache.set(channelId, channelInfo);
        } catch {
          // Default to assuming it's a DM if we can't fetch info
          channelInfo = { isDM: true };
          this.channelCache.set(channelId, channelInfo);
        }
      }

      // Detect bot mention: <@BOT_USER_ID>
      const wasMentioned = this.botUserId
        ? content.includes(`<@${this.botUserId}>`)
        : false;

      const isGroupChat = !channelInfo.isDM;

      // Check authorization
      const sendMessageToUser = async (cId: string, text: string) => {
        if (this.app) {
          await this.app.client.chat.postMessage({
            channel: cId,
            text: text,
          });
        }
      };

      const isAuthorized = await this.auth.checkAuthorization(
        userId,
        channelId,
        username,
        isGroupChat,
        wasMentioned,
        sendMessageToUser,
        this.type
      );

      // Handle admin commands and challenge codes in DM
      if (!isGroupChat && (content.startsWith("/") || content.match(/^\d{6}$/))) {
        const handled = await this.auth.handleAdminCommand(
          content,
          channelId,
          userId,
          async (text) => await this.sendMessage(channelId, text),
          this.type
        );
        if (handled) {
          return;
        }
      }

      if (!isAuthorized) {
        return; // Auth handler already sent challenge/error messages
      }

      // Forward to message handler
      if (this.messageHandler) {
        const externalMessage: ExternalMessage = {
          chatId: channelId,
          transport: this.type,
          content,
          username: username,
          userId: userId,
          timestamp: new Date(parseFloat(ts) * 1000),
          messageId: ts,
          isGroupChat,
          wasMentioned,
        };

        this.messageHandler(externalMessage);
      }
    });

    // Handle errors
    this.app.error(async (error: any) => {
      if (this.errorHandler) {
        this.errorHandler(new Error(String(error)));
      }
    });

    try {
      await this.app.start();
      this._isConnected = true;
    } catch (error) {
      throw new Error(`Slack connection failed: ${(error as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch {
        // Ignore stop errors
      }
      this.app = null;
    }
    this._isConnected = false;
    this.userCache.clear();
    this.channelCache.clear();
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.sendMessageInThread(chatId, text);
  }

  async sendMessageInThread(
    chatId: string,
    text: string,
    threadTs?: string,
    footerText?: string,
  ): Promise<string | undefined> {
    if (!this.app) {
      throw new Error("Slack not connected");
    }
    if (!text?.trim()) return threadTs;

    try {
      const messageChunks = splitMarkdownIntoMessages(text);
      let rootThreadTs = threadTs;

      for (let i = 0; i < messageChunks.length; i++) {
        const chunk = messageChunks[i];
        const blocks = markdownToBlocks(chunk);
        if (footerText && i === messageChunks.length - 1) {
          blocks.push({
            type: "context",
            elements: [{ type: "mrkdwn", text: footerText }],
          });
        }

        const response = await this.app.client.chat.postMessage({
          channel: chatId,
          text: chunk,
          blocks,
          thread_ts: rootThreadTs,
        });

        if (!rootThreadTs) {
          rootThreadTs = response.ts;
        }
      }

      return rootThreadTs;
    } catch (error) {
      throw new Error(`Slack send failed: ${(error as Error).message}`);
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Slack doesn't support typing indicators for bots
  }

  async addReaction(chatId: string, messageTs: string, emoji: string): Promise<void> {
    if (!this.app) {
      throw new Error("Slack not connected");
    }

    try {
      await this.app.client.reactions.add({
        channel: chatId,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (error: any) {
      const code = error?.data?.error || error?.code || error?.message;
      if (code === "already_reacted") return;
      throw new Error(`Slack add reaction failed: ${String(code)}`);
    }
  }

  async removeReaction(chatId: string, messageTs: string, emoji: string): Promise<void> {
    if (!this.app) {
      throw new Error("Slack not connected");
    }

    try {
      await this.app.client.reactions.remove({
        channel: chatId,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (error: any) {
      const code = error?.data?.error || error?.code || error?.message;
      if (code === "no_reaction" || code === "message_not_found") return;
      throw new Error(`Slack remove reaction failed: ${String(code)}`);
    }
  }

  async sendFile(chatId: string, filePath: string, options?: TransportFileOptions): Promise<void> {
    if (!this.app) {
      throw new Error("Slack not connected");
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    try {
      await this.app.client.files.uploadV2({
        channel_id: chatId,
        file: fs.createReadStream(filePath),
        filename: path.basename(filePath),
        title: options?.title,
        initial_comment: options?.initialComment,
      });
    } catch (error) {
      throw new Error(`Slack file upload failed: ${(error as Error).message}`);
    }
  }

  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }
}
