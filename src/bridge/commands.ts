/**
 * commands.ts — Bridge command definitions shared between Slack remote and TUI local handlers.
 */

// ── Bridge status text ─────────────────────────────────────────────────────

export function buildBridgeStatusText(
  slackConnected: boolean,
  trustedUsers: number,
  usersByTransport: Record<string, string[]>,
  channels: number,
): string {
  const lines = [
    "━━━ Slack Bridge Status ━━━",
    "",
    "Transport:",
    `  ${slackConnected ? "●" : "○"} slack`,
    "",
    `Trusted Users: ${trustedUsers}`,
  ];

  if (trustedUsers > 0) {
    for (const [transport, userIds] of Object.entries(usersByTransport)) {
      if (userIds.length > 0) {
        lines.push(`  └─ ${transport}: ${userIds.join(", ")}`);
      }
    }
  }

  lines.push("");
  lines.push(`Channels: ${channels}`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

// ── Remote command list ────────────────────────────────────────────────────

export function buildRemoteCommandList(
  commands: Array<{ source: string; name: string; description?: string }>,
): string {
  const skills = commands
    .filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
    .map((command) => ({
      name: command.name.slice("skill:".length),
      description: command.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const prompts = commands
    .filter((command) => command.source === "prompt")
    .map((command) => ({
      name: command.name,
      description: command.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const lines = [
    "Available remote commands",
    "",
    "General",
    "- `.` — show this command list",
    "",
    "Skills",
    ...(skills.length > 0
      ? skills.map((skill) => `- \`.skill ${skill.name} <args>\`${skill.description ? ` — ${skill.description}` : ""}`)
      : ["- None"]),
    "",
    "Prompts",
    ...(prompts.length > 0
      ? prompts.map((prompt) => `- \`.prompt ${prompt.name} <args>\`${prompt.description ? ` — ${prompt.description}` : ""}`)
      : ["- None"]),
    "",
    "Bridge",
    "- `.bridge status`",
    "- `.bridge connect`",
    "- `.bridge disconnect`",
    "- `.bridge new [cwd]`",
    "- `.bridge list-sessions [number]`",
    "- `.bridge switch <number>`",
    "- `.bridge sendfile <path>`",
  ];

  return lines.join("\n");
}

// ── Bridge help text ───────────────────────────────────────────────────────

export function buildBridgeHelpText(): string {
  return [
    "━━━ Slack Bridge Commands ━━━",
    "",
    "/msg-bridge                   Open interactive menu",
    "/msg-bridge help              Show this help",
    "/msg-bridge status            Show Slack connection and user status",
    "/msg-bridge connect           Connect to Slack",
    "/msg-bridge disconnect        Disconnect from Slack",
    "/msg-bridge configure slack <bot-token> <app-token>",
    "                              Configure Slack bot",
    "/msg-bridge widget            Toggle status widget on/off",
    "/msg-bridge new [cwd]         Start a fresh bridge session for current or specified directory",
    "/msg-bridge list-sessions [number]  Show recent sessions (default 10)",
    "/msg-bridge switch <number>   Switch to one of all recent sessions",
    "/msg-bridge sendfile <path>   Upload a local file to current Slack chat",
    "/msg-bridge releaseclaim      Re-open claiming for Slack",
    "/msg-bridge optout            Opt this session out of automatic bridge takeover",
    "/msg-bridge optin             Re-allow this session to take over the bridge",
    "/msg-bridge optout list       Show sessions opted out of takeover",
    "/msg-bridge toggletools       Toggle tool call visibility",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  ].join("\n");
}

// ── Handover reason text ───────────────────────────────────────────────────

export function getSlackHandoverReasonText(reason?: "user-request" | "active-session"): string {
  switch (reason) {
    case "user-request":
      return "Switched by user request.";
    case "active-session":
      return "Bridge moved to the active local session.";
    default:
      return "Continuing in another pi session.";
  }
}
