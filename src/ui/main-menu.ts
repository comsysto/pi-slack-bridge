/**
 * main-menu.ts — Interactive main menu for /slk-bridge.
 *
 * Shows Slack connection status, with Connect, Configure, Widget, and Help.
 */

import type { ChallengeAuth } from "../auth/challenge.js";
import { loadConfig, saveConfig } from "../config/index.js";
import { acquireLock, releaseLock } from "../session/lock.js";
import { SlackClient } from "../slack/client.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type MenuUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type: "info" | "warning" | "error"): void;
};

export interface MenuContext {
  ui: MenuUI;
  slackClient: SlackClient | null;
  auth: ChallengeAuth;
  updateWidget: () => void;
  connectCurrentSession: () => Promise<void>;
  getCurrentSessionFile?: () => string | undefined;
}

// ── Status ──────────────────────────────────────────────────────────────────

function getStatusLine(mctx: MenuContext): string {
  const connected = mctx.slackClient?.isConnected ?? false;
  const stats = mctx.auth.getStats();

  const statusLine = connected
    ? "  ● Connected"
    : "  ○ Disconnected";

  return `${statusLine}\n  Trusted user: ${stats.trustedUser ?? "None"}`;
}

// ── Help ────────────────────────────────────────────────────────────────────

// FYI: resolved — renamed to /slk-bridge, configure no longer needs 'slack' argument
function showHelp(mctx: MenuContext): void {
  mctx.ui.notify(
    "Subcommands:\n" +
    "  /slk-bridge status                — show Slack connection status\n" +
    "  /slk-bridge connect               — connect Slack\n" +
    "  /slk-bridge disconnect            — disconnect Slack\n" +
    "  /slk-bridge configure             — set up Slack bot token + app token\n" +
    "  /slk-bridge widget                — toggle status widget\n" +
    "  /slk-bridge list-sessions         — show up to 10 recent sessions\n" +
    "  /slk-bridge switch <number>       — switch to a listed session\n" +
    "  /slk-bridge sendfile <path>       — upload local file to current Slack chat",
    "info",
  );
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function doConnect(mctx: MenuContext): Promise<void> {
  try {
    await mctx.connectCurrentSession();
    mctx.ui.notify("✅ Slack connected", "info");
    mctx.updateWidget();
  } catch (err) {
    releaseLock();
    mctx.ui.notify(`❌ Connection failed: ${(err as Error).message}`, "error");
  }
}

async function doDisconnect(mctx: MenuContext): Promise<void> {
  if (mctx.slackClient) {
    await mctx.slackClient.disconnect();
  }
  releaseLock();
  const cfg = loadConfig();
  cfg.autoConnect = false;
  saveConfig(cfg);
  mctx.ui.notify("🔌 Slack disconnected", "info");
  mctx.updateWidget();
}

async function doConfigure(mctx: MenuContext): Promise<void> {
  const config = loadConfig();

  const botToken = await mctx.ui.input("Slack bot token (xoxb-...)");
  if (!botToken) return;
  const appToken = await mctx.ui.input("Slack app token (xapp-...)");
  if (!appToken) return;

  config.slack = { botToken, appToken };
  saveConfig(config);

  const client = new SlackClient(config.slack, mctx.auth);
  mctx.slackClient = client;

  if (acquireLock()) {
    try {
      await client.connect();
      mctx.ui.notify("✅ Slack configured and connected", "info");
    } catch (err) {
      releaseLock();
      mctx.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
    }
  } else {
    mctx.ui.notify("✅ Slack configured (another instance is connected — run /slk-bridge connect later)", "info");
  }

  mctx.updateWidget();
}

function doToggleWidget(mctx: MenuContext): void {
  const cfg = loadConfig();
  cfg.showWidget = cfg.showWidget === false;
  saveConfig(cfg);
  const state = cfg.showWidget !== false ? "shown" : "hidden";
  mctx.ui.notify(`📊 Status widget ${state}`, "info");
  mctx.updateWidget();
}

function doOptOut(mctx: MenuContext): void {
  const sessionFile = mctx.getCurrentSessionFile?.();
  if (!sessionFile) {
    mctx.ui.notify("❌ No session file available for this session", "error");
    return;
  }
  const cfg = loadConfig();
  const optedOut = cfg.optedOutSessions ?? [];
  if (optedOut.includes(sessionFile)) {
    mctx.ui.notify("ℹ️ This session is already opted out of bridge takeover", "info");
    return;
  }
  optedOut.push(sessionFile);
  cfg.optedOutSessions = optedOut;
  saveConfig(cfg);
  mctx.ui.notify("🛑 This session will NOT take over the Slack bridge when active", "info");
}

function doOptIn(mctx: MenuContext): void {
  const sessionFile = mctx.getCurrentSessionFile?.();
  if (!sessionFile) {
    mctx.ui.notify("❌ No session file available for this session", "error");
    return;
  }
  const cfg = loadConfig();
  const optedOut = cfg.optedOutSessions ?? [];
  const idx = optedOut.indexOf(sessionFile);
  if (idx === -1) {
    mctx.ui.notify("ℹ️ This session was not opted out — nothing to do", "info");
    return;
  }
  optedOut.splice(idx, 1);
  cfg.optedOutSessions = optedOut.length > 0 ? optedOut : undefined;
  saveConfig(cfg);
  mctx.ui.notify("✅ This session can now take over the Slack bridge again", "info");
}

// ── Main menu ───────────────────────────────────────────────────────────────

export async function openMainMenu(mctx: MenuContext): Promise<void> {
  const mainMenu = async (): Promise<void> => {
    const statusLine = getStatusLine(mctx);
    const title = `Slack Bridge\n${statusLine}`;

    const connected = mctx.slackClient?.isConnected ?? false;

    const choices = [
      connected ? "Disconnect" : "Connect",
      "Configure",
      "Widget",
      "Opt out",
      "Opt in",
      "Help",
    ];

    const choice = await mctx.ui.select(title, choices);
    if (!choice) return;

    switch (choice) {
      case "Connect":
        await doConnect(mctx);
        break;
      case "Disconnect":
        await doDisconnect(mctx);
        break;
      case "Configure":
        await doConfigure(mctx);
        break;
      case "Widget":
        doToggleWidget(mctx);
        break;
      case "Opt out":
        doOptOut(mctx);
        break;
      case "Opt in":
        doOptIn(mctx);
        break;
      case "Help":
        showHelp(mctx);
        break;
    }
    return mainMenu();
  };
  await mainMenu();
}
