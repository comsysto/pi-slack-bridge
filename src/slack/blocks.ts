import { splitMessage } from "./formatting.js";

/**
 * Convert text to Slack Block Kit blocks using the native markdown block type.
 *
 * Important Slack behavior for the bridge:
 * - although a markdown block allows up to 12,000 characters, larger rich markdown
 *   payloads can still fail Slack validation after internal translation
 * - keep each posted Slack message conservatively below the documented block max (6,000 chars)
 * - split content on markdown-aware boundaries when possible
 * - send multiple Slack messages for longer replies instead of building one oversized payload
 */

interface SlackBlock {
  type: string;
  text?: string | { type: string; text: string };
  [key: string]: any;
}

interface MarkdownToken {
  type: "heading" | "paragraph" | "table" | "code" | "list" | "quote" | "hr";
  text: string;
}

export const MAX_SLACK_MARKDOWN_CHARS_PER_MESSAGE = 6000;

/**
 * Split markdown text into Slack-safe message chunks.
 *
 * Strategy:
 * - prefer markdown section boundaries (headers / horizontal rules)
 * - keep code blocks, tables, lists and quotes intact when they fit
 * - split oversized tables by rows and repeat the header
 * - split oversized prose by paragraph/sentence boundaries before falling back to raw splitting
 */
export function splitMarkdownIntoMessages(text: string): string[] {
  if (!text?.trim()) {
    return [""];
  }

  const tokens = tokenizeMarkdown(text);
  const sections = groupTokensIntoSections(tokens);
  const messages: string[] = [];
  let current: MarkdownToken[] = [];

  const flushCurrent = () => {
    if (current.length === 0) return;
    messages.push(composeTokens(current));
    current = [];
  };

  for (const section of sections) {
    const sectionChunks = splitTokenGroupToFit(section, MAX_SLACK_MARKDOWN_CHARS_PER_MESSAGE);

    for (const chunk of sectionChunks) {
      const candidate = current.length === 0 ? composeTokens(chunk) : composeTokens([...current, ...chunk]);
      if (candidate.length <= MAX_SLACK_MARKDOWN_CHARS_PER_MESSAGE) {
        current = [...current, ...chunk];
      } else {
        flushCurrent();
        current = [...chunk];
      }
    }
  }

  flushCurrent();
  return messages;
}

/**
 * Convert a single Slack-safe markdown chunk to blocks.
 */
export function markdownToBlocks(text: string): SlackBlock[] {
  if (!text?.trim()) {
    return [{ type: "markdown", text: "" }];
  }

  return [{ type: "markdown", text }];
}

function tokenizeMarkdown(text: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const block: string[] = [line];
      i++;
      while (i < lines.length) {
        block.push(lines[i]);
        if (lines[i].startsWith(fence)) {
          i++;
          break;
        }
        i++;
      }
      tokens.push({ type: "code", text: block.join("\n") });
      continue;
    }

    if (isHorizontalRule(line)) {
      tokens.push({ type: "hr", text: line.trim() });
      i++;
      continue;
    }

    if (isHeading(line)) {
      tokens.push({ type: "heading", text: line.trim() });
      i++;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      tokens.push({ type: "table", text: tableLines.join("\n") });
      continue;
    }

    if (isListItem(line)) {
      const listLines = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== "" && (isListItem(lines[i]) || isListContinuation(lines[i]))) {
        listLines.push(lines[i]);
        i++;
      }
      tokens.push({ type: "list", text: listLines.join("\n") });
      continue;
    }

    if (isQuoteLine(line)) {
      const quoteLines = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== "" && isQuoteLine(lines[i])) {
        quoteLines.push(lines[i]);
        i++;
      }
      tokens.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }

    const paragraphLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "") {
      if (
        isHeading(lines[i]) ||
        isHorizontalRule(lines[i]) ||
        lines[i].match(/^(`{3,}|~{3,})/) ||
        (isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) ||
        isListItem(lines[i]) ||
        isQuoteLine(lines[i])
      ) {
        break;
      }
      paragraphLines.push(lines[i]);
      i++;
    }
    tokens.push({ type: "paragraph", text: paragraphLines.join("\n").trim() });
  }

  return tokens;
}

function groupTokensIntoSections(tokens: MarkdownToken[]): MarkdownToken[][] {
  const sections: MarkdownToken[][] = [];
  let current: MarkdownToken[] = [];

  const flush = () => {
    if (current.length > 0) {
      sections.push(current);
      current = [];
    }
  };

  for (const token of tokens) {
    if (token.type === "heading") {
      flush();
      current = [token];
      continue;
    }

    if (token.type === "hr") {
      flush();
      sections.push([token]);
      continue;
    }

    current.push(token);
  }

  flush();
  return sections;
}

function splitTokenGroupToFit(tokens: MarkdownToken[], maxLen: number): MarkdownToken[][] {
  const chunks: MarkdownToken[][] = [];
  let current: MarkdownToken[] = [];

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
    }
  };

  for (const token of tokens) {
    const tokenParts = splitTokenToFit(token, maxLen);

    for (const part of tokenParts) {
      const candidate = current.length === 0 ? composeTokens([part]) : composeTokens([...current, part]);
      if (candidate.length <= maxLen) {
        current.push(part);
      } else {
        flush();
        current.push(part);
      }
    }
  }

  flush();
  return chunks;
}

function splitTokenToFit(token: MarkdownToken, maxLen: number): MarkdownToken[] {
  if (composeTokens([token]).length <= maxLen) {
    return [token];
  }

  switch (token.type) {
    case "table":
      return splitTableToken(token, maxLen);
    case "paragraph":
      return splitParagraphToken(token, maxLen);
    case "list":
      return splitLineGroupedToken(token, maxLen, extractListItems, "list");
    case "quote":
      return splitLineGroupedToken(token, maxLen, extractQuoteParagraphs, "quote");
    case "code":
      return splitCodeToken(token, maxLen);
    default:
      return splitRawToken(token, maxLen);
  }
}

function splitTableToken(token: MarkdownToken, maxLen: number): MarkdownToken[] {
  const lines = token.text.split("\n");
  if (lines.length < 3) {
    return splitRawToken(token, maxLen);
  }

  const [header, separator, ...rows] = lines;
  const tablePrefix = [header, separator].join("\n");
  if (tablePrefix.length > maxLen) {
    return splitRawToken(token, maxLen);
  }

  const parts: MarkdownToken[] = [];
  let currentRows: string[] = [];

  const flush = () => {
    if (currentRows.length === 0) return;
    parts.push({
      type: "table",
      text: [header, separator, ...currentRows].join("\n"),
    });
    currentRows = [];
  };

  for (const row of rows) {
    const candidateRows = [...currentRows, row];
    const candidateText = [header, separator, ...candidateRows].join("\n");

    if (candidateText.length <= maxLen) {
      currentRows = candidateRows;
      continue;
    }

    if (currentRows.length > 0) {
      flush();
    }

    if ([header, separator, row].join("\n").length <= maxLen) {
      currentRows = [row];
    } else {
      parts.push(...splitRawToken({ type: "paragraph", text: row }, maxLen));
    }
  }

  flush();
  return parts.length > 0 ? parts : splitRawToken(token, maxLen);
}

function splitParagraphToken(token: MarkdownToken, maxLen: number): MarkdownToken[] {
  const normalized = token.text.replace(/\n+/g, " ").trim();
  const sentences = splitIntoSentences(normalized);
  if (sentences.length <= 1) {
    return splitRawToken({ ...token, text: normalized }, maxLen);
  }

  const parts: MarkdownToken[] = [];
  let current = "";

  const flush = () => {
    if (!current.trim()) return;
    parts.push({ type: "paragraph", text: current.trim() });
    current = "";
  };

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= maxLen) {
      current = candidate;
    } else {
      flush();
      if (sentence.length <= maxLen) {
        current = sentence;
      } else {
        parts.push(...splitRawToken({ type: "paragraph", text: sentence }, maxLen));
      }
    }
  }

  flush();
  return parts;
}

function splitLineGroupedToken(
  token: MarkdownToken,
  maxLen: number,
  extractor: (text: string) => string[],
  type: MarkdownToken["type"],
): MarkdownToken[] {
  const groups = extractor(token.text);
  if (groups.length <= 1) {
    return splitRawToken(token, maxLen);
  }

  const parts: MarkdownToken[] = [];
  let currentGroups: string[] = [];

  const flush = () => {
    if (currentGroups.length === 0) return;
    parts.push({ type, text: currentGroups.join("\n") });
    currentGroups = [];
  };

  for (const group of groups) {
    const candidate = [...currentGroups, group].join("\n");
    if (candidate.length <= maxLen) {
      currentGroups.push(group);
    } else {
      flush();
      if (group.length <= maxLen) {
        currentGroups = [group];
      } else {
        parts.push(...splitRawToken({ type, text: group }, maxLen));
      }
    }
  }

  flush();
  return parts;
}

function splitCodeToken(token: MarkdownToken, maxLen: number): MarkdownToken[] {
  const lines = token.text.split("\n");
  if (lines.length < 2) {
    return splitRawToken(token, maxLen);
  }

  const opening = lines[0];
  const closing = lines[lines.length - 1].match(/^(`{3,}|~{3,})/) ? lines[lines.length - 1] : opening.slice(0, 3);
  const bodyLines = lines.slice(1, lines.length - 1);
  const shellLen = `${opening}\n\n${closing}`.length;
  if (shellLen >= maxLen) {
    return splitRawToken(token, maxLen);
  }

  const parts: MarkdownToken[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    parts.push({ type: "code", text: [opening, ...current, closing].join("\n") });
    current = [];
  };

  for (const line of bodyLines) {
    const candidate = [opening, ...current, line, closing].join("\n");
    if (candidate.length <= maxLen) {
      current.push(line);
    } else {
      flush();
      if ([opening, line, closing].join("\n").length <= maxLen) {
        current = [line];
      } else {
        parts.push(...splitRawToken({ type: "paragraph", text: line }, maxLen).map((part) => ({
          type: "code" as const,
          text: [opening, part.text, closing].join("\n"),
        })));
      }
    }
  }

  flush();
  return parts;
}

function splitRawToken(token: MarkdownToken, maxLen: number): MarkdownToken[] {
  return splitMessage(token.text, maxLen).map((part) => ({ type: token.type, text: part.trim() }));
}

function composeTokens(tokens: MarkdownToken[]): string {
  return tokens.map((token) => token.text.trim()).filter(Boolean).join("\n\n");
}

function splitIntoSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g);
  if (!matches) {
    return [text];
  }
  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

function extractListItems(text: string): string[] {
  const lines = text.split("\n");
  const items: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    items.push(current.join("\n"));
    current = [];
  };

  for (const line of lines) {
    if (isListItem(line)) {
      flush();
      current = [line];
    } else {
      current.push(line);
    }
  }

  flush();
  return items.length > 0 ? items : [text];
}

function extractQuoteParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line.trim());
}

function isHorizontalRule(line: string): boolean {
  return /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line);
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.split("|").length >= 3;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false;
  const cells = trimmed.split("|").slice(1, -1);
  return cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

function isListItem(line: string): boolean {
  return /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)\]]\s+/.test(line);
}

function isListContinuation(line: string): boolean {
  return /^\s{2,}\S/.test(line) && !isListItem(line);
}

function isQuoteLine(line: string): boolean {
  return /^\s*>/.test(line);
}
