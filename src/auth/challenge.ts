/**
 * Challenge-based authentication for Slack bridge users
 */

import { loadConfig, saveConfig } from "../config/index.js";

interface ChallengeData {
  code: string;
  userId: string;
  chatId: string;
  username: string;
  expiresAt: number;
  attempts: number;
}

interface ChannelAuth {
  enabled: boolean;
  mode: "all" | "mentions" | "trusted-only";
}

/**
 * Manages authentication via 6-digit challenge codes and trusted users
 */
export class ChallengeAuth {
  private challenges = new Map<string, ChallengeData>();
  private trustedUser: string | undefined;
  private channelAuth = new Map<string, ChannelAuth>();
  private blockedUsers = new Map<string, number>(); // userId -> unblock timestamp
  private userChats = new Map<string, string>(); // userId -> DM chatId
  private claimOpen = true;

  constructor(
    private onShowCode: (code: string, username: string) => void,
    private onNotify: (message: string, level?: "info" | "warning" | "error") => void,
    private onSendMessage?: (chatId: string, message: string) => Promise<void>,
    private onSaveAuth?: () => void
  ) {}

  /**
   * Initialize auth state from config
   */
  loadFromConfig(config: {
    trustedUser?: string;
    channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
    userChats?: Record<string, string>;
    claimOpen?: boolean;
  }): void {
    if (config.trustedUser) {
      this.trustedUser = config.trustedUser;
    }
    if (config.channels) {
      this.channelAuth = new Map(Object.entries(config.channels));
    }
    if (config.userChats) {
      this.userChats = new Map(Object.entries(config.userChats));
    }
    if (config.claimOpen !== undefined) {
      this.claimOpen = config.claimOpen;
    }
  }

  /**
   * Export auth state for config persistence
   */
  exportConfig(): {
    trustedUser?: string;
    channels: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
    userChats: Record<string, string>;
    claimOpen: boolean;
  } {
    return {
      trustedUser: this.trustedUser,
      channels: Object.fromEntries(this.channelAuth),
      userChats: Object.fromEntries(this.userChats),
      claimOpen: this.claimOpen,
    };
  }

  /**
   * Check if a user is authorized to send messages
   * Handles challenge creation, validation, and channel authorization
   */
  async checkAuthorization(
    userId: string,
    chatId: string,
    username: string,
    isGroupChat: boolean,
    wasMentioned: boolean,
    sendMessage?: (chatId: string, message: string) => Promise<void>
  ): Promise<boolean> {
    const namespacedUserId = userId;
    
    // Check if user is blocked
    const blockedUntil = this.blockedUsers.get(namespacedUserId);
    if (blockedUntil && Date.now() < blockedUntil) {
      return false;
    }
    if (blockedUntil && Date.now() >= blockedUntil) {
      this.blockedUsers.delete(namespacedUserId);
    }

    // DM: check trusted or initiate challenge
    if (!isGroupChat) {
      if (this.trustedUser === namespacedUserId) {
        this.rememberUserChat(namespacedUserId, chatId);
        return true;
      }

      if (!this.claimOpen) {
        return false;
      }

      // Temporarily override onSendMessage for this challenge if provided
      if (sendMessage) {
        const originalSender = this.onSendMessage;
        this.onSendMessage = sendMessage;
        const result = await this.initiateChallenge(namespacedUserId, chatId, username);
        this.onSendMessage = originalSender;
        return result;
      }
      
      return await this.initiateChallenge(namespacedUserId, chatId, username);
    }

    // Group chat: check channel authorization
    const channelAuthData = this.channelAuth.get(chatId);

    // Channel not enabled
    if (!channelAuthData?.enabled) {
      return false;
    }

    // Check mode
    switch (channelAuthData.mode) {
      case "all":
        return true;
      case "mentions":
        return wasMentioned || false;
      case "trusted-only":
        return this.trustedUser === namespacedUserId;
      default:
        return false;
    }
  }

  /**
   * Initiate or validate a challenge
   */
  private async initiateChallenge(
    userId: string,
    chatId: string,
    username: string
  ): Promise<boolean> {
    const existingChallenge = this.challenges.get(userId);

    // Check if there's an active challenge
    if (existingChallenge) {
      // Expired?
      if (Date.now() > existingChallenge.expiresAt) {
        this.challenges.delete(userId);
        return await this.initiateChallenge(userId, chatId, username);
      }

      // Challenge still active, return false (user needs to enter code)
      return false;
    }

    // Create new challenge
    const code = this.generateCode();
    const expiresAt = Date.now() + 2 * 60 * 1000; // 2 minutes

    this.challenges.set(userId, {
      code,
      userId,
      chatId,
      username,
      expiresAt,
      attempts: 0,
    });

    // Show code in terminal FIRST
    this.onShowCode(code, username);
    
    // Then send message to user asking for the code
    if (this.onSendMessage) {
      try {
        await this.onSendMessage(
          chatId,
          "🔐 Please enter the 6-digit code provided by the bot admin.\n⏱️ Expires in 2 minutes."
        );
      } catch (_err) {
        // Ignore send errors
      }
    }
    
    return false;
  }

  /**
   * Handle admin commands in DM
   * Returns true if command was handled
   */
  async handleAdminCommand(
    text: string,
    _chatId: string,
    userId: string,
    sendMessage: (text: string) => Promise<void>
  ): Promise<boolean> {
    const namespacedUserId = userId;
    
    // Non-trusted users: check for challenge code entry
    if (this.trustedUser !== namespacedUserId) {
      const challenge = this.challenges.get(namespacedUserId);
      if (challenge && text.match(/^\d{6}$/)) {
        return await this.validateChallenge(namespacedUserId, text, sendMessage);
      }
      return false;
    }

    this.rememberUserChat(namespacedUserId, _chatId);

    // Admin commands
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case "/help":
        await sendMessage(this.getHelpText());
        return true;

      case "/enable":
        if (parts.length < 3) {
          await sendMessage("Usage: /enable <chatId> <all|mentions|trusted-only>");
          return true;
        }
        this.channelAuth.set(parts[1], {
          enabled: true,
          mode: parts[2] as any,
        });
        if (this.onSaveAuth) this.onSaveAuth();
        await sendMessage(`✅ Channel ${parts[1]} enabled (mode: ${parts[2]})`);
        this.onNotify(`Channel ${parts[1]} enabled (${parts[2]})`, "info");
        return true;

      case "/disable":
        if (parts.length < 2) {
          await sendMessage("Usage: /disable <chatId>");
          return true;
        }
        this.channelAuth.delete(parts[1]);
        if (this.onSaveAuth) this.onSaveAuth();
        await sendMessage(`❌ Channel ${parts[1]} disabled`);
        this.onNotify(`Channel ${parts[1]} disabled`, "info");
        return true;

      case "/channels": {
        const channels = Array.from(this.channelAuth.entries())
          .map(([id, auth]) => `• ${id}: ${auth.enabled ? "✅" : "❌"} (${auth.mode})`)
          .join("\n");
        await sendMessage(channels || "No channels configured");
        return true;
      }

      case "/trusted": {
        await sendMessage(`Trusted user: ${this.trustedUser ?? "None"}`);
        return true;
      }

      case "/toggletools": {
        const cfg = loadConfig();
        cfg.hideToolCalls = !cfg.hideToolCalls;
        saveConfig(cfg);
        const state = cfg.hideToolCalls ? "hidden" : "shown";
        await sendMessage(`🔧 Tool calls ${state} in remote messages`);
        return true;
      }

      case "/revoke": {
        if (!this.trustedUser) {
          await sendMessage("❌ No trusted user to revoke");
          return true;
        }
        const revokeId = parts[1];
        if (revokeId && (revokeId === this.trustedUser || revokeId === this.trustedUser.split(":")[1])) {
          this.trustedUser = undefined;
          if (this.onSaveAuth) this.onSaveAuth();
          await sendMessage(`🔓 Revoked trust for ${this.trustedUser}`);
          this.onNotify(`Revoked: ${this.trustedUser}`, "warning");
        } else if (!revokeId) {
          this.trustedUser = undefined;
          if (this.onSaveAuth) this.onSaveAuth();
          await sendMessage("🔓 Revoked current trusted user");
          this.onNotify("Revoked current trusted user", "warning");
        } else {
          await sendMessage(`❌ ${revokeId} is not the trusted user`);
        }
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * Validate a challenge code entered by the user
   */
  private async validateChallenge(
    userId: string,
    code: string,
    sendMessage: (text: string) => Promise<void>
  ): Promise<boolean> {
    const challenge = this.challenges.get(userId);
    if (!challenge) return false;

    // Expired?
    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(userId);
      await sendMessage("⏱️ Challenge expired. Send any message to get a new code.");
      return true;
    }

    // Correct code?
    if (code === challenge.code) {
      this.trustedUser = userId;
      this.rememberUserChat(userId, challenge.chatId);
      this.claimOpen = false;
      this.challenges.delete(userId);
      if (this.onSaveAuth) this.onSaveAuth();
      await sendMessage("✅ Authenticated! You can now chat with the agent.");
      this.onNotify(`✅ ${challenge.username} authenticated`, "info");
      return true;
    }

    // Wrong code
    challenge.attempts++;
    if (challenge.attempts >= 3) {
      this.challenges.delete(userId);
      this.blockedUsers.set(userId, Date.now() + 5 * 60 * 1000); // 5 min block
      await sendMessage("🚫 Too many failed attempts. Blocked for 5 minutes.");
      this.onNotify(`🚫 ${challenge.username} blocked (3 failed attempts)`, "warning");
      return true;
    }

    await sendMessage(
      `❌ Wrong code. ${3 - challenge.attempts} attempts remaining.`
    );
    return true;
  }

  /**
   * Generate a random 6-digit code
   */
  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private rememberUserChat(userId: string, chatId: string): void {
    if (!chatId || this.userChats.get(userId) === chatId) return;
    this.userChats.set(userId, chatId);
    if (this.onSaveAuth) this.onSaveAuth();
  }

  isClaimOpen(): boolean {
    return this.claimOpen;
  }

  releaseClaim(): number {
    const hadUser = this.trustedUser ? 1 : 0;
    this.trustedUser = undefined;
    this.userChats.clear();
    this.challenges.clear();
    this.blockedUsers.clear();
    this.claimOpen = true;
    if (this.onSaveAuth) this.onSaveAuth();
    return hadUser;
  }

  getNotificationChatIds(): string[] {
    if (this.trustedUser) {
      const chatId = this.userChats.get(this.trustedUser);
      if (chatId) {
        return [chatId];
      }
    }
    return [];
  }

  /**
   * Get help text for admin commands
   */
  private getHelpText(): string {
    return `**Commands**

*DM Only:*
• \`/help\` — Show this help
• \`/trusted\` — Show trusted user
• \`/revoke\` — Revoke trust for current user
• \`/channels\` — List enabled channels
• \`/enable <chatId> <mode>\` — Enable a channel
  Modes: \`all\`, \`mentions\`, \`trusted-only\`
• \`/disable <chatId>\` — Disable a channel
• \`/toggletools\` — Toggle tool call visibility in replies

*Authentication:*
• First DM to bot → 6-digit code shown in terminal
• Enter code in chat → become trusted
• After first auth, new DM claims stay closed until released locally via \`/slk-bridge releaseclaim\``;
  }

  /**
   * Get current stats with detailed user info
   */
  getStats(): {
    trustedUser: string | undefined;
    channels: number;
  } {
    return {
      trustedUser: this.trustedUser,
      channels: Array.from(this.channelAuth.values()).filter((a) => a.enabled).length,
    };
  }
}
