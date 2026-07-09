/**
 * Status widget showing Slack bridge connection status
 */

export interface SlackStatus {
  connected: boolean;
}

export function createStatusWidget(
  slackStatus: SlackStatus,
  usersByTransport: Record<string, string[]>
): string | undefined {
  const userCount = usersByTransport.slack?.length || 0;
  const userSuffix = userCount > 0 ? `:${userCount}` : "";
  const abbrev = "slk";

  return slackStatus.connected
    ? `💬 [${abbrev}${userSuffix}]`
    : undefined;
}
