import { describe, expect, it } from 'vitest';
import {
  markdownToBlocks,
  MAX_SLACK_MARKDOWN_CHARS_PER_MESSAGE,
  splitMarkdownIntoMessages,
} from '../../src/slack/blocks';

describe('splitMarkdownIntoMessages', () => {
  it('returns a single chunk for short markdown', () => {
    const text = '# Hello\n\nThis is short.';
    expect(splitMarkdownIntoMessages(text)).toEqual([text]);
  });

  it('splits long markdown into Slack-safe chunks', () => {
    const paragraph = 'A'.repeat(5000);
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;

    const chunks = splitMarkdownIntoMessages(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= MAX_SLACK_MARKDOWN_CHARS_PER_MESSAGE)).toBe(true);
    expect(chunks.join('')).toBe(text.replace(/\n/g, ''));
  });

  it('keeps markdown tables together when they fit inside one chunk', () => {
    const table = [
      '| Key | Status |',
      '| --- | --- |',
      '| LOGSCICT-661 | In Dev |',
      '| LOGDIME-786 | In Review |',
    ].join('\n');
    const text = `## Intro\n\nShort paragraph.\n\n${table}`;

    const chunks = splitMarkdownIntoMessages(text);

    expect(chunks.some((chunk) => chunk.includes(table))).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= MAX_SLACK_MARKDOWN_CHARS_PER_MESSAGE)).toBe(true);
  });

  it('splits huge tables by rows and repeats the table header', () => {
    const header = '| Key | Status | Summary |';
    const separator = '| --- | --- | --- |';
    const rows = Array.from({ length: 500 }, (_, i) => `| LOG-${i} | In Dev | Summary row ${i} with more content to enlarge the table chunk size |`);
    const text = ['## Huge table', '', header, separator, ...rows].join('\n');

    const chunks = splitMarkdownIntoMessages(text);
    const tableChunks = chunks.filter((chunk) => chunk.includes(header) && chunk.includes(separator));

    expect(chunks.length).toBeGreaterThan(1);
    expect(tableChunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= MAX_SLACK_MARKDOWN_CHARS_PER_MESSAGE)).toBe(true);
    expect(tableChunks.every((chunk) => chunk.includes(header))).toBe(true);
    expect(tableChunks.every((chunk) => chunk.includes(separator))).toBe(true);
    expect(rows.every((row) => chunks.some((chunk) => chunk.includes(row)))).toBe(true);
  });

  it('prefers heading boundaries when splitting long markdown', () => {
    const sectionA = 'Sentence one. Sentence two. '.repeat(180);
    const sectionB = 'Another section. More text. '.repeat(180);
    const text = `## Section A\n\n${sectionA}\n\n## Section B\n\n${sectionB}`;

    const chunks = splitMarkdownIntoMessages(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('## Section A');
    expect(chunks.some((chunk) => chunk.includes('## Section B'))).toBe(true);
  });
});

describe('markdownToBlocks', () => {
  it('wraps a chunk in a single markdown block', () => {
    const text = '*hello*\n\n| a | b |';
    expect(markdownToBlocks(text)).toEqual([{ type: 'markdown', text }]);
  });
});
