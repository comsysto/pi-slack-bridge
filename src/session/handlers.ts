/**
 * handlers.ts — Session-level helper functions used by the bridge extension.
 *
 * Extracted from bridge/index.ts to keep the extension file focused on lifecycle wiring.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as os from "os";
import * as path from "path";
import { truncate } from "../slack/formatting.js";

const execFileAsync = promisify(execFile);

/** Minimal shape: anything with a getBranch method returning message-like entries */
export type BranchProvider = {
  getBranch(fromId?: string): Array<Record<string, any>>;
};

export interface SessionContext {
  sessionManager: BranchProvider;
  cwd: string;
  model?: { provider?: string; id?: string; contextWindow?: number };
  getContextUsage(): { percent: number | null; contextWindow?: number } | undefined;
}

// ── Prompt helpers ─────────────────────────────────────────────────────────

export function getFirstSessionPrompt(sessionManager: BranchProvider): string {
  const branch = sessionManager.getBranch();
  const firstUserMessage = branch.find(
    (entry: any) => entry.type === "message" && entry.message?.role === "user",
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

/** Format token count the same way pi's TUI footer does:
 *  - < 1000: raw number
 *  - < 10000: (count / 1000).toFixed(1) + "k"   (e.g. 1024 → "1.0k")
 *  - < 1000000: Math.round(count / 1000) + "k"   (e.g. 128000 → "128k")
 *  - < 10000000: (count / 1000000).toFixed(1) + "M" (e.g. 1048576 → "1.0M")
 *  - >= 10000000: Math.round(count / 1000000) + "M"
 */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function formatContextUsage(ctx: SessionContext): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;

  if (!usage || !contextWindow) {
    return "? / ?";
  }

  const percent = usage.percent === null ? "?" : `${usage.percent.toFixed(1)}%`;
  const windowStr = formatTokens(contextWindow);
  return `${percent} / ${windowStr}`;
}

export function formatDisplayPath(cwd: string): string {
  const home = os.homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}${path.sep}`)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd });
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

export async function buildSlackFooterText(ctx: SessionContext): Promise<string> {
  const modelProvider = ctx.model?.provider || "unknown";
  const modelId = ctx.model?.id || "unknown";
  const displayPath = formatDisplayPath(ctx.cwd);
  const branch = await getGitBranch(ctx.cwd);
  const location = branch ? `${displayPath} (${branch})` : displayPath;
  const firstPrompt = truncate(getFirstSessionPrompt(ctx.sessionManager).replace(/\s+/g, " ").trim(), 120);
  return `${location} · ${formatContextUsage(ctx)} · (${modelProvider}) ${modelId} · ${firstPrompt}`;
}

// ── Conversation helpers ───────────────────────────────────────────────────

/** Safely extract text from any message (handles string content and array content) */
export function extractTextSafe(message: { content?: unknown }): string {
  if (!message?.content) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text ?? "")
      .join("\n");
  }
  return "";
}

export interface AssistantMessageInfo {
  entryId: string;
  text: string;
}

/** Get all completed assistant messages from the session branch, oldest first */
export function getAllAssistantMessages(sessionManager: BranchProvider): AssistantMessageInfo[] {
  const branch = sessionManager.getBranch();
  const messages: AssistantMessageInfo[] = [];

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    if (entry.message?.role !== "assistant") continue;
    if (entry.message?.stopReason && entry.message.stopReason !== "stop") continue;

    const text = extractTextSafe(entry.message).trim();
    if (text && typeof entry.id === "string" && entry.id) {
      messages.push({ entryId: entry.id, text });
    }
  }

  return messages;
}

export type ConversationEntry = { role: "user" | "assistant"; text: string };

/** Get full conversation history (user + assistant) interleaved in order, oldest first */
export function getConversationHistory(sessionManager: BranchProvider): ConversationEntry[] {
  const branch = sessionManager.getBranch();
  const entries: ConversationEntry[] = [];

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    if (entry.message?.role === "user") {
      const text = extractTextSafe(entry.message).trim();
      if (text) {
        entries.push({ role: "user", text });
      }
    } else if (entry.message?.role === "assistant") {
      if (entry.message?.stopReason && entry.message.stopReason !== "stop") continue;
      const text = extractTextSafe(entry.message).trim();
      if (text && typeof entry.id === "string" && entry.id) {
        entries.push({ role: "assistant", text });
      }
    }
  }

  return entries;
}

export function getLastAssistantMessageInfo(sessionManager: BranchProvider): AssistantMessageInfo | null {
  const messages = getAllAssistantMessages(sessionManager);
  return messages.length > 0 ? messages[messages.length - 1] : null;
}

export function getLastAssistantMessageText(sessionManager: BranchProvider): string | null {
  return getLastAssistantMessageInfo(sessionManager)?.text ?? null;
}

// ── Session listing ────────────────────────────────────────────────────────

export async function listRecentSessions(limit?: number): Promise<Array<{
  path: string;
  cwd: string;
  firstPrompt: string;
  messageCount: number;
}>> {
  const sessions = await SessionManager.listAll();
  const sorted = sessions
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .map((session) => ({
      path: session.path,
      cwd: session.cwd || "(unknown cwd)",
      firstPrompt: truncate((session.firstMessage || "(no prompt)").replace(/\s+/g, " ").trim(), 300),
      messageCount: session.messageCount,
    }));

  return limit ? sorted.slice(0, limit) : sorted;
}

export async function buildSessionListText(limit: number = 10): Promise<string> {
  const sessions = await listRecentSessions(limit);
  if (sessions.length === 0) {
    return "No previous sessions found.";
  }

  const lines = ["Previous sessions", ""];
  sessions.forEach((session, index) => {
    lines.push(`${index + 1}. **${session.cwd}** — ${session.firstPrompt}, *${session.messageCount} messages*`);
  });

  return lines.join("\n").trimEnd();
}
