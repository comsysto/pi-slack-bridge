/**
 * External message received from a messenger transport
 */
export interface ExternalMessage {
  /** Unique chat/channel identifier */
  chatId: string;
  /** Transport type (telegram, whatsapp, etc) */
  transport: string;
  /** Message content/text */
  content: string;
  /** Sender username */
  username: string;
  /** Sender user ID */
  userId: string;
  /** Message timestamp */
  timestamp: Date;
  /** Unique message identifier */
  messageId: string;
  /** Is this a group/channel message? */
  isGroupChat: boolean;
  /** Was the bot mentioned? (for group chats) */
  wasMentioned?: boolean;
  /** Transport-specific reply thread/root identifier, when available */
  threadId?: string;
  /** Whether the incoming message was sent as a reply inside an existing thread */
  isThreadReply?: boolean;
}

/**
 * Configuration for msg-bridge extension
 */
export interface MsgBridgeConfig {
  telegram?: {
    token: string;
  };
  whatsapp?: {
    authPath?: string;
  };
  slack?: {
    botToken: string;
    appToken: string;
  };
  discord?: {
    token: string;
  };
  matrix?: {
    homeserverUrl: string;
    accessToken: string;
    encryption?: boolean;
  };
  auth?: {
    trustedUsers?: string[];
    adminUserId?: string;
    channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
    userChats?: Record<string, string>;
    claimOpenByTransport?: Record<string, boolean>;
  };
  slackRouting?: {
    threadsByKey?: Record<string, { sessionPath: string; updatedAt: string }>;
    activeThreadBySessionChat?: Record<string, { threadTs: string; updatedAt: string }>;
    lastAssistantDeliveryByThread?: Record<string, { sessionPath: string; assistantEntryId: string; updatedAt: string }>;
  };
  hideToolCalls?: boolean;
  autoConnect?: boolean;
  showWidget?: boolean;
  debug?: boolean;
}

/**
 * Pending remote chat session tracking
 */
export interface PendingRemoteChat {
  chatId: string;
  transport: string;
  username: string;
  messageId: string;
  threadId?: string;
  isThreadReply?: boolean;
}

/**
 * Transport connection status
 */
export interface TransportStatus {
  type: string;
  connected: boolean;
  error?: string;
}
