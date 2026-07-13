import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SlackBridgeConfig } from "../types/index.js";

const CONFIG_DIR = path.join(os.homedir(), ".pi");
const CONFIG_PATH = path.join(CONFIG_DIR, "slk-bridge.json");

/**
 * Load config from file and env vars (env vars override file).
 */
export function loadConfig(): SlackBridgeConfig {
  const config: SlackBridgeConfig = {};

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const stats = fs.statSync(CONFIG_PATH);
      const mode = stats.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        console.warn(`⚠️  Config file ${CONFIG_PATH} has insecure permissions (${mode.toString(8)}). Should be 0600.`);
      }

      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      Object.assign(config, fileConfig);
    } catch (err) {
      console.error("Failed to load config file:", err);
    }
  }

  // Environment variables override file config (higher priority)
  if (process.env.PI_SLACK_BOT_TOKEN && process.env.PI_SLACK_APP_TOKEN) {
    config.slack = {
      botToken: process.env.PI_SLACK_BOT_TOKEN,
      appToken: process.env.PI_SLACK_APP_TOKEN,
    };
  }

  return config;
}

/**
 * Save config to file with secure permissions.
 */
export function saveConfig(config: SlackBridgeConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch (err) {
    console.warn("Failed to set directory permissions:", err);
  }
}
