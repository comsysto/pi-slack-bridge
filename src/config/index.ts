import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SlackBridgeConfig } from "../types/index.js";

const CONFIG_DIR = path.join(os.homedir(), ".pi");
const CONFIG_PATH = path.join(CONFIG_DIR, "slk-bridge.json");
const LEGACY_CONFIG_PATH = path.join(CONFIG_DIR, "msg-bridge.json");

/**
 * Load config from file and env vars (env vars override file).
 */
export function loadConfig(): SlackBridgeConfig {
  const config: SlackBridgeConfig = {};

  // Load from new path first, fall back to legacy msg-bridge.json
  const configPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : LEGACY_CONFIG_PATH;
  if (fs.existsSync(configPath)) {
    try {
      const stats = fs.statSync(configPath);
      const mode = stats.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        console.warn(`⚠️  Config file ${configPath} has insecure permissions (${mode.toString(8)}). Should be 0600.`);
      }

      const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
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
  // Always save to the new path; legacy file is left in place for rollback but not updated
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch (err) {
    console.warn("Failed to set directory permissions:", err);
  }
}
