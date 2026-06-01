/**
 * Convert text to Slack Block Kit blocks using the native markdown block type.
 * 
 * The `markdown` block type accepts standard markdown directly, including:
 * - Headers (## h2, ### h3)
 * - Tables (| col | col |)
 * - Code blocks (```)
 * - Bold (**text**), italic (_text_), strikethrough (~~text~~)
 * - Lists (- item, 1. item)
 * - Blockquotes (> text)
 * - Links ([text](url))
 * - Inline code (`code`)
 * 
 * The cumulative limit for all markdown blocks in a single payload is 12,000 characters.
 */

interface SlackBlock {
  type: string;
  text?: string | { type: string; text: string };
  [key: string]: any;
}

const MAX_MARKDOWN_BLOCK_LENGTH = 12000;

/**
 * Convert markdown text to Slack Block Kit blocks.
 * Uses the native `markdown` block type which handles standard markdown formatting.
 */
export function markdownToBlocks(text: string): SlackBlock[] {
  if (!text?.trim()) {
    return [{ type: "markdown", text: "" }];
  }

  // If text fits in a single markdown block, just use it directly
  if (text.length <= MAX_MARKDOWN_BLOCK_LENGTH) {
    return [{ type: "markdown", text: text }];
  }

  // For very long messages, split into multiple markdown blocks
  const blocks: SlackBlock[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MARKDOWN_BLOCK_LENGTH) {
      blocks.push({ type: "markdown", text: remaining });
      break;
    }

    // Try to break at a good boundary
    let breakAt = findBreakPoint(remaining, MAX_MARKDOWN_BLOCK_LENGTH);
    blocks.push({ type: "markdown", text: remaining.substring(0, breakAt) });
    remaining = remaining.substring(breakAt).trimStart();
  }

  return blocks;
}

/**
 * Find a good break point in text, preferring paragraph breaks, then line breaks.
 */
function findBreakPoint(text: string, maxLen: number): number {
  // Try double newline (paragraph break)
  let breakAt = text.lastIndexOf("\n\n", maxLen);
  if (breakAt > maxLen * 0.5) return breakAt;

  // Try single newline
  breakAt = text.lastIndexOf("\n", maxLen);
  if (breakAt > maxLen * 0.5) return breakAt;

  // Try space
  breakAt = text.lastIndexOf(" ", maxLen);
  if (breakAt > maxLen * 0.3) return breakAt;

  // Hard break
  return maxLen;
}
