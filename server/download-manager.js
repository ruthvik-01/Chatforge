// server/download-manager.js – One-time secure download token store
import { randomBytes } from "crypto";
import env from "../config/env-loader.js";
import logger from "./logger.js";

// Map<token, { filePath, expiresAt, used }>
export const downloadTokens = new Map();

/**
 * Register a file for one-time download and return a full URL.
 * Returns null if PUBLIC_URL is not configured.
 * @param {string} filePath  Absolute path to the file on disk.
 * @returns {string|null}
 */
export function createDownloadToken(filePath) {
  if (!env.PUBLIC_URL) return null;
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + env.DOWNLOAD_LINK_TTL_SECONDS * 1000;
  downloadTokens.set(token, { filePath, expiresAt, used: false });
  setTimeout(() => downloadTokens.delete(token), env.DOWNLOAD_LINK_TTL_SECONDS * 1000);
  logger.info("download-manager: token created", {
    token: token.slice(0, 8) + "…",
    expiresAt: new Date(expiresAt).toISOString(),
  });
  return `${env.PUBLIC_URL}/download/${token}`;
}
