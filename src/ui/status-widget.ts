/**
 * Status widget showing Slack bridge connection status.
 * Renders a minimal ascii dot (● connected / ○ disconnected)
 * that matches the style of /slk-bridge status output.
 */

export interface SlackStatus {
  connected: boolean;
}

export function createStatusWidget(
  slackStatus: SlackStatus,
  _usersByTransport: Record<string, string[]>
): string | undefined {
  // Minimal dot + slk label — matches /slk-bridge status output style: ● slack / ○ slack
  return slackStatus.connected ? "● slk" : "○ slk";
}
