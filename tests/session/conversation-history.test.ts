import { describe, expect, it } from 'vitest';

function extractTextSafe(message: { content?: unknown }): string {
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text ?? '')
      .join('\n');
  }
  return '';
}

type BranchEntry = {
  type: string;
  id?: string;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }> | string;
    stopReason?: string;
  };
};

type ConversationEntry = {
  role: 'user' | 'assistant';
  text: string;
};

function getConversationHistory(branch: BranchEntry[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    if (entry.message?.role === 'user') {
      const text = extractTextSafe(entry.message).trim();
      if (text) entries.push({ role: 'user', text });
    } else if (entry.message?.role === 'assistant') {
      if (entry.message?.stopReason && entry.message.stopReason !== 'stop') continue;
      const text = extractTextSafe(entry.message).trim();
      if (text && typeof entry.id === 'string' && entry.id) {
        entries.push({ role: 'assistant', text });
      }
    }
  }
  return entries;
}

const mockBranch: BranchEntry[] = [
  { type: 'message', id: 'msg-1', message: { role: 'user', content: [{ type: 'text', text: 'first user message' }] } },
  { type: 'message', id: 'msg-2', message: { role: 'assistant', content: [{ type: 'text', text: 'first assistant response' }], stopReason: 'stop' } },
  { type: 'message', id: 'msg-3', message: { role: 'user', content: [{ type: 'text', text: 'second user message' }] } },
  { type: 'message', id: 'msg-4', message: { role: 'assistant', content: [{ type: 'text', text: 'second assistant response' }], stopReason: 'stop' } },
  { type: 'tool_call' },
  { type: 'message', id: 'msg-5', message: { role: 'assistant', content: [{ type: 'text', text: 'partial assistant (no stopReason)' }] } },
  { type: 'message', id: 'msg-6', message: { role: 'user', content: [{ type: 'text', text: '' }] } },
];

describe('getConversationHistory', () => {
  it('extracts 5 entries (2 user + 3 assistant)', () => {
    expect(getConversationHistory(mockBranch)).toHaveLength(5);
  });

  it('preserves user/assistant interleaving order', () => {
    const roles = getConversationHistory(mockBranch).map(e => e.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'assistant']);
  });

  it('skips tool_call entries', () => {
    const toolEntries = getConversationHistory(mockBranch).filter(e => e.role === 'tool_call' as any);
    expect(toolEntries).toHaveLength(0);
  });

  it('skips empty user messages', () => {
    const empty = getConversationHistory(mockBranch).filter(e => e.role === 'user' && e.text === '');
    expect(empty).toHaveLength(0);
  });

  it('formats user messages with emoji prefix', () => {
    const userEntries = getConversationHistory(mockBranch).filter(e => e.role === 'user');
    const formatted = userEntries.map(e => `\u{1f5e3}\ufe0f **User:** ${e.text}`);
    expect(formatted).toHaveLength(2);
    expect(formatted[0]).toContain('**User:**');
  });

  it('handles string-content user messages', () => {
    const branch: BranchEntry[] = [
      { type: 'message', id: 'msg-s1', message: { role: 'user', content: 'plain string user message' } },
      { type: 'message', id: 'msg-s2', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant response' }], stopReason: 'stop' } },
    ];
    const history = getConversationHistory(branch);
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[0].text).toBe('plain string user message');
    expect(history[1].role).toBe('assistant');
    expect(history[1].text).toBe('assistant response');
  });
});
