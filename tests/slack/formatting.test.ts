import { describe, expect, it } from 'vitest';
import {
  formatToolCalls,
  splitMessage,
  truncate,
} from '../../src/slack/formatting';

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates with ellipsis at maxLen', () => {
    expect(truncate('hello world!', 8)).toBe('hello...');
  });

  it('returns empty string for falsy input', () => {
    expect(truncate('', 10)).toBe('');
  });
});

describe('splitMessage', () => {
  it('returns single chunk for short text', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello']);
  });

  it('splits at newline boundary and preserves all content', () => {
    const text = 'aaaa\nbbbb\ncccc';
    // maxLen=9: "aaaa\nbbbb" is 9 chars, so first chunk should be exactly that
    const chunks = splitMessage(text, 9);
    expect(chunks).toEqual(['aaaa\nbbbb', 'cccc']);
  });

  it('splits at space when no good newline exists', () => {
    const text = 'hello world goodbye world';
    const chunks = splitMessage(text, 15);
    // Should break at space, not mid-word
    expect(chunks[0]).toBe('hello world');
    expect(chunks[1]).toBe('goodbye world');
  });

  it('hard-cuts continuous text and preserves all content', () => {
    const text = 'a'.repeat(100);
    const chunks = splitMessage(text, 30);
    expect(chunks.join('')).toBe(text);
    // First chunks should be exactly maxLen
    expect(chunks[0].length).toBe(30);
  });

  it('handles text that is exactly maxLen', () => {
    const text = 'a'.repeat(50);
    expect(splitMessage(text, 50)).toEqual([text]);
  });
});

describe('formatToolCalls', () => {
  it('formats tool calls with arguments', () => {
    const msg = {
      content: [
        {
          type: 'toolCall',
          name: 'grep',
          arguments: { pattern: 'hello', path: '/src' },
        },
      ],
    } as any;
    const result = formatToolCalls(msg);
    expect(result).toBe('🔧 `grep` (pattern=hello, path=/src)');
  });

  it('formats tool calls without arguments', () => {
    const msg = {
      content: [{ type: 'toolCall', name: 'status', arguments: {} }],
    } as any;
    expect(formatToolCalls(msg)).toBe('🔧 `status`');
  });

  it('returns empty string when no tool calls', () => {
    const msg = {
      content: [{ type: 'text', text: 'hi' }],
    } as any;
    expect(formatToolCalls(msg)).toBe('');
  });

  it('truncates long argument values at 50 chars', () => {
    const longVal = 'x'.repeat(100);
    const msg = {
      content: [
        {
          type: 'toolCall',
          name: 'write',
          arguments: { content: longVal },
        },
      ],
    } as any;
    const result = formatToolCalls(msg);
    // 50 chars: 47 x's + "..."
    expect(result).toContain('content=' + 'x'.repeat(47) + '...');
  });

  it('joins multiple tool calls with newlines', () => {
    const msg = {
      content: [
        { type: 'toolCall', name: 'grep', arguments: { pattern: 'a' } },
        { type: 'toolCall', name: 'read', arguments: { path: '/b' } },
      ],
    } as any;
    const result = formatToolCalls(msg);
    expect(result).toBe('🔧 `grep` (pattern=a)\n🔧 `read` (path=/b)');
  });
});
