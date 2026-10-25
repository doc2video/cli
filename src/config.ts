import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "https://doc2video.io";

// DOC2VIDEO_CONFIG_DIR lets tests (or multiple accounts) use a separate config
const CONFIG_DIR = process.env.DOC2VIDEO_CONFIG_DIR || join(homedir(), ".doc2video");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/** A device login started with `d2v login --start`, finished by `d2v login --wait`. */
export interface PendingLogin {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  interval: number;
  baseUrl: string;
}

export interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
  pendingLogin?: PendingLogin;
}

export interface ResolvedConfig {
  apiKey: string | null;
  baseUrl: string;
  /** Where the API key came from, for `d2v whoami`. */
  keySource: "flag" | "env" | "config" | null;
}

export function configPath(): string {
  return CONFIG_FILE;
}

export function readConfig(): StoredConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as StoredConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: StoredConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions
  }
}

/** Save a newly issued key (and the server it belongs to, when not the default). */
export function saveLogin(apiKey: string, baseUrl: string): void {
  const { pendingLogin: _done, ...stored } = readConfig();
  writeConfig({ ...stored, apiKey, baseUrl: baseUrl === DEFAULT_BASE_URL ? stored.baseUrl : baseUrl });
}

export function clearConfig(): void {
  rmSync(CONFIG_FILE, { force: true });
}

/** Precedence: --key/--url flags, then DOC2VIDEO_API_KEY/DOC2VIDEO_URL, then the config file. */
export function resolveConfig(flags: { key?: string; url?: string } = {}): ResolvedConfig {
  const stored = readConfig();
  const envKey = process.env.DOC2VIDEO_API_KEY || undefined;
  const apiKey = flags.key ?? envKey ?? stored.apiKey ?? null;
  const keySource = flags.key ? "flag" : envKey ? "env" : stored.apiKey ? "config" : null;
  const baseUrl = (flags.url ?? process.env.DOC2VIDEO_URL ?? stored.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return { apiKey, baseUrl, keySource };
}
