/**
 * main-menu.ts — Interactive main menu for /slk-bridge.
 *
 * Pure UI layer — collects user input and delegates actions to the bridge.
 * The bridge owns all state and all Slack lifecycle.
 */

import { buildBridgeHelpText } from "../bridge/commands.js";
import { loadConfig, saveConfig } from "../config/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type MenuUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type: "info" | "warning" | "error"): void;
};

export interface MenuContext {
  ui: MenuUI;

  /** Reconnect Slack with current config (create client, connect, wire handler). */
  reconnect: () => Promise<void>;

  /** Disconnect Slack and release lock. */
  disconnect: () => Promise<void>;

  /** Toggle tool call visibility in remote messages. */
  toggleToolCalls: () => void;

  /** Toggle auto-connect on session resume. */
  toggleAutoConnect: () => void;

  /** Opt current session out of automatic bridge takeover. */
  optOut: () => void;

  /** Re-allow current session to take over the bridge. */
  optIn: () => void;

  /** Get a status line string for the menu title. */
  getStatusLine: () => string;
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function doConnect(mctx: MenuContext): Promise<void> {
  try {
    await mctx.reconnect();
    mctx.ui.notify("✅ Slack connected", "info");
  } catch (err) {
    mctx.ui.notify(`❌ Connection failed: ${(err as Error).message}`, "error");
  }
}

async function doDisconnect(mctx: MenuContext): Promise<void> {
  await mctx.disconnect();
  mctx.ui.notify("🔌 Slack disconnected", "info");
}

async function doConfigure(mctx: MenuContext): Promise<void> {
  const config = loadConfig();

  const botToken = await mctx.ui.input("Slack bot token (xoxb-...)");
  if (!botToken) return;
  const appToken = await mctx.ui.input("Slack app token (xapp-...)");
  if (!appToken) return;

  config.slack = { botToken, appToken };
  saveConfig(config);

  try {
    await mctx.reconnect();
    mctx.ui.notify("✅ Slack configured and connected", "info");
  } catch (err) {
    mctx.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
  }
}

// ── Main menu ───────────────────────────────────────────────────────────────

export async function openMainMenu(mctx: MenuContext): Promise<void> {
  const mainMenu = async (): Promise<void> => {
    const title = `Slack Bridge\n${mctx.getStatusLine()}`;

    const choices = [
      "Connect",
      "Disconnect",
      "Configure",
      "Toggle Tool Calls",
      "Toggle Auto Connect",
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
      case "Toggle Tool Calls":
        mctx.toggleToolCalls();
        break;
      case "Toggle Auto Connect":
        mctx.toggleAutoConnect();
        break;
      case "Opt out":
        mctx.optOut();
        break;
      case "Opt in":
        mctx.optIn();
        break;
      case "Help":
        mctx.ui.notify(buildBridgeHelpText(), "info");
        break;
    }
    return mainMenu();
  };
  await mainMenu();
}
