/**
 * Quick test to verify getConversationHistory logic.
 * Simulates branch entries to check user/assistant interleaving.
 */

// Safe text extraction (handles both string content and array content)
function extractTextSafe(message: { content?: unknown }): string {
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

type BranchEntry = {
  type: string;
  id?: string;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }>;
    stopReason?: string;
  };
};

type ConversationEntry = {
  role: "user" | "assistant";
  text: string;
};

function getConversationHistory(branch: BranchEntry[]): ConversationEntry[] {
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

// Mock branch data simulating a real pi session
const mockBranch: BranchEntry[] = [
  {
    type: "message",
    id: "msg-1",
    message: {
      role: "user",
      content: [
        { type: "text", text: "hey check out the codebase in cwd, whats it about?" }
      ],
    },
  },
  {
    type: "message",
    id: "msg-2",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Here's what this codebase is about..." },
      ],
      stopReason: "stop",
    },
  },
  {
    type: "message",
    id: "msg-3",
    message: {
      role: "user",
      content: [
        { type: "text", text: "so check git log, this is a fork that deviated a bit and focused only on slack" },
      ],
    },
  },
  {
    type: "message",
    id: "msg-4",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Great, the git log confirms exactly what you described." },
      ],
      stopReason: "stop",
    },
  },
  {
    type: "tool_call", // should be skipped
  },
  {
    type: "message",
    id: "msg-5",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "This is a partial assistant message (no stopReason)" },
      ],
      // no stopReason — should be skipped
    },
  },
  {
    type: "message",
    id: "msg-6",
    message: {
      role: "user",
      content: [
        { type: "text", text: "" }, // empty — should be skipped
      ],
    },
  },
];

const history = getConversationHistory(mockBranch);

console.log("=== Conversation History ===");
console.log(`Found ${history.length} entries\n`);

for (let i = 0; i < history.length; i++) {
  const entry = history[i];
  const formatted = entry.role === "user"
    ? `🗣️ **User:** ${entry.text}`
    : entry.text;
  console.log(`[${i + 1}] (${entry.role}): ${formatted.slice(0, 80)}...`);
}

console.log("\nExpected: 5 entries (2 user + 3 assistant — partial msg without stopReason is included, matching original getAllAssistantMessages behavior)");
console.log("Actual:  ", history.length === 5 ? "✅ PASS" : "❌ FAIL");

// Check ordering
const roles = history.map(e => e.role);
console.log("Order:   ", roles.join(" → "));
console.log("Expected: user → assistant → user → assistant → assistant");
const correctOrder =
  roles[0] === "user" &&
  roles[1] === "assistant" &&
  roles[2] === "user" &&
  roles[3] === "assistant" &&
  roles[4] === "assistant";
console.log("Order check:", correctOrder ? "✅ PASS" : "❌ FAIL");

// Verify user messages get the emoji+bold prefix
const userEntries = history.filter(e => e.role === "user");
const formatted = userEntries.map(e => `🗣️ **User:** ${e.text}`);
console.log("\nUser formatting check:", formatted.length === 2 ? "✅ PASS" : "❌ FAIL");
console.log("  ", formatted[0].slice(0, 50));

// Test string-content user message (the real pi bug)
const mockBranchWithStringContent: BranchEntry[] = [
  {
    type: "message",
    id: "msg-s1",
    message: {
      role: "user",
      content: "plain string user message", // string, not array
    },
  },
  {
    type: "message",
    id: "msg-s2",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "assistant response" }],
      stopReason: "stop",
    },
  },
];

const history2 = getConversationHistory(mockBranchWithStringContent);
console.log("\n=== String content test ===");
console.log("Found:", history2.length === 2 ? "✅ PASS" : "❌ FAIL");
console.log("User text:", history2[0].text === "plain string user message" ? "✅ PASS" : "❌ FAIL");
console.log("User role:", history2[0].role === "user" ? "✅ PASS" : "❌ FAIL");
console.log("Assistant role:", history2[1].role === "assistant" ? "✅ PASS" : "❌ FAIL");
