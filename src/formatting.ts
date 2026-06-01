import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Extract text from assistant message.
 */
export function extractTextFromMessage(message: AssistantMessage): string {
  const textParts = message.content.filter((part) => part.type === "text");
  return textParts.map((part: any) => part.text).join("\n");
}

/**
 * Check if assistant message contains tool calls (more turns will follow).
 */
export function hasToolCalls(message: AssistantMessage): boolean {
  return message.content.some((part) => part.type === "toolCall");
}

/**
 * Format tool call summaries for the remote user.
 */
export function formatToolCalls(message: AssistantMessage): string {
  const toolCalls = message.content.filter((part) => part.type === "toolCall");
  if (toolCalls.length === 0) return "";
  return toolCalls
    .map((tc: any) => {
      const name = tc.name || "tool";
      const args = tc.arguments || {};

      const argPairs = Object.entries(args)
        .map(([k, v]) => {
          const valStr = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}=${truncate(valStr, 50)}`;
        })
        .join(", ");

      // Wrap the tool name in backticks so messengers render it as inline
      // code — preserves snake_case readability across Telegram (which would
      // otherwise have to backslash-escape underscores), Discord, Slack,
      // Matrix, and WhatsApp uniformly.
      return argPairs ? `🔧 \`${name}\` (${argPairs})` : `🔧 \`${name}\``;
    })
    .join("\n");
}

/**
 * Truncate string to max length with ellipsis.
 */
export function truncate(str: string, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}

/**
 * Split long messages into chunks, breaking at newlines when possible.
 * Content-aware: never splits inside tables, code blocks, or lists.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  // Parse text into content blocks that should not be split
  const contentBlocks = parseContentBlocks(text);

  const chunks: string[] = [];
  let currentChunk = "";

  for (const block of contentBlocks) {
    // If adding this block would exceed the limit
    if (currentChunk.length + block.length > maxLen) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }

      // If a single block exceeds maxLen, we have to force-split it
      if (block.length > maxLen) {
        const forcedChunks = forceSplit(block, maxLen);
        // All but last go directly to chunks
        for (let i = 0; i < forcedChunks.length - 1; i++) {
          chunks.push(forcedChunks[i].trim());
        }
        currentChunk = forcedChunks[forcedChunks.length - 1];
      } else {
        currentChunk = block;
      }
    } else {
      currentChunk += block;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text.substring(0, maxLen)];
}

/**
 * Parse text into atomic content blocks that should be kept together.
 * Each block is a unit that should not be split across messages.
 */
function parseContentBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split("\n");
  let i = 0;
  let currentBlock: string[] = [];

  const flushCurrent = () => {
    if (currentBlock.length > 0) {
      blocks.push(currentBlock.join("\n"));
      currentBlock = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Detect fenced code blocks (``` or ~~~)
    if (line.match(/^(`{3,}|~{3,})/)) {
      flushCurrent();
      const fence = line.match(/^(`{3,}|~{3,})/)?.[0] || "```";
      const codeLines: string[] = [line];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        codeLines.push(lines[i]); // closing fence
        i++;
      }
      blocks.push(codeLines.join("\n") + "\n");
      continue;
    }

    // Detect markdown tables (| col | col |)
    if (isTableRow(line)) {
      // Look ahead for separator to confirm table
      if (i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        flushCurrent();
        const tableLines: string[] = [line];
        i++;
        // Collect all contiguous table rows (including separator)
        while (i < lines.length && (isTableRow(lines[i]) || isTableSeparator(lines[i]))) {
          tableLines.push(lines[i]);
          i++;
        }
        blocks.push(tableLines.join("\n") + "\n");
        continue;
      }
    }

    // Detect blockquotes (consecutive > lines)
    if (line.match(/^\s*>/)) {
      flushCurrent();
      const quoteLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].match(/^\s*>/)) {
        quoteLines.push(lines[i]);
        i++;
      }
      blocks.push(quoteLines.join("\n") + "\n");
      continue;
    }

    // Detect lists (consecutive - , * , or 1. lines, including indented continuations)
    if (isListItem(line)) {
      flushCurrent();
      const listLines: string[] = [line];
      i++;
      while (i < lines.length && (isListItem(lines[i]) || isListContinuation(lines[i]))) {
        listLines.push(lines[i]);
        i++;
      }
      blocks.push(listLines.join("\n") + "\n");
      continue;
    }

    // Detect headers — keep header with following paragraph
    if (line.match(/^#{1,6}\s+/)) {
      flushCurrent();
      const headerLines: string[] = [line];
      i++;
      // Attach the next paragraph to the header
      while (i < lines.length && lines[i].trim() !== "" && !lines[i].match(/^#{1,6}\s+/) && !isTableRow(lines[i]) && !lines[i].match(/^(`{3,}|~{3,})/) && !isListItem(lines[i]) && !lines[i].match(/^\s*>/)) {
        headerLines.push(lines[i]);
        i++;
      }
      blocks.push(headerLines.join("\n") + "\n");
      continue;
    }

    // Regular paragraph text — group by paragraph (separated by empty lines)
    if (line.trim() === "") {
      flushCurrent();
      blocks.push("\n");
      i++;
      continue;
    }

    currentBlock.push(line);
    i++;
  }

  flushCurrent();
  return blocks;
}

/**
 * Check if a line looks like a markdown table row.
 */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.split("|").length >= 3;
}

/**
 * Check if a line is a table separator (|---|---|).
 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  const cells = trimmed.split("|").slice(1, -1);
  return cells.every(cell => /^\s*:?-+:?\s*$/.test(cell));
}

/**
 * Check if a line is a list item (bullet or ordered).
 */
function isListItem(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)\]]\s+/.test(line);
}

/**
 * Check if a line is a list continuation (indented non-empty line after a list item).
 */
function isListContinuation(line: string): boolean {
  return /^\s{2,}\S/.test(line) && !line.match(/^\s*[-*+]\s+/) && !line.match(/^\s*\d+[.)\]]\s+/);
}

/**
 * Force-split a block that exceeds maxLen, trying to break at newlines.
 */
function forceSplit(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt < maxLen * 0.5) {
      breakAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (breakAt < maxLen * 0.3) {
      breakAt = maxLen;
    }

    chunks.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).trimStart();
  }

  return chunks;
}
