// server/credential-manager.js – Encrypted credential storage with TTL
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { encrypt, decrypt } from "../config/encryption.js";
import env from "../config/env-loader.js";
import logger from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = path.resolve(__dirname, "..", "secrets");

/** In-memory credential cache: { key: { ciphertext, expiresAt } } */
const store = new Map();

// Ensure secrets directory exists
if (!fs.existsSync(SECRETS_DIR)) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
}

/**
 * Load all persisted credentials from disk into memory on startup.
 * Expired entries are deleted immediately.
 */
function loadCredentialsFromDisk() {
  if (!fs.existsSync(SECRETS_DIR)) return;
  const files = fs.readdirSync(SECRETS_DIR).filter((f) => f.endsWith(".enc"));
  let loaded = 0;
  for (const file of files) {
    const key = file.replace(/\.enc$/, "");
    const filePath = path.join(SECRETS_DIR, file);
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Date.now() > entry.expiresAt) {
        fs.unlinkSync(filePath);
        logger.info(`credential-manager: removed expired credential [${key}] from disk`);
        continue;
      }
      store.set(key, entry);
      loaded++;
    } catch {
      logger.warn(`credential-manager: failed to load [${key}], removing corrupted file`);
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  }
  if (loaded > 0) {
    logger.info(`credential-manager: loaded ${loaded} credential(s) from disk`);
  }
}

// Load persisted credentials on module init
loadCredentialsFromDisk();

/**
 * Store a credential (encrypted both in-memory and on-disk).
 * @param {string} key   e.g. "VERCEL_TOKEN"
 * @param {string} value plaintext secret
 */
export function setCredential(key, value) {
  const sanitizedKey = key.replace(/[^A-Za-z0-9_]/g, "");
  if (!sanitizedKey) throw new Error("Invalid credential key.");

  const ciphertext = encrypt(value);
  const expiresAt = Date.now() + env.CREDENTIAL_TTL_SECONDS * 1000;

  store.set(sanitizedKey, { ciphertext, expiresAt });

  // Persist encrypted value to disk
  const filePath = path.join(SECRETS_DIR, `${sanitizedKey}.enc`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ ciphertext, expiresAt }),
    "utf8"
  );
  // Restrict file permissions on Linux
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows doesn't support chmod – acceptable
  }

  logger.info(`credential-manager: stored credential [${sanitizedKey}]`);
}

/**
 * Retrieve a credential (plaintext). Returns null if missing or expired.
 * @param {string} key
 * @returns {string|null}
 */
export function getCredential(key) {
  const sanitizedKey = key.replace(/[^A-Za-z0-9_]/g, "");

  // Check in-memory cache first
  let entry = store.get(sanitizedKey);

  // Fall back to disk
  if (!entry) {
    const filePath = path.join(SECRETS_DIR, `${sanitizedKey}.enc`);
    if (fs.existsSync(filePath)) {
      try {
        entry = JSON.parse(fs.readFileSync(filePath, "utf8"));
        store.set(sanitizedKey, entry);
      } catch {
        return null;
      }
    }
  }

  if (!entry) return null;

  // Check expiration
  if (Date.now() > entry.expiresAt) {
    deleteCredential(sanitizedKey);
    logger.info(`credential-manager: credential [${sanitizedKey}] expired`);
    return null;
  }

  return decrypt(entry.ciphertext);
}

/**
 * Delete a credential from memory and disk.
 * @param {string} key
 */
export function deleteCredential(key) {
  const sanitizedKey = key.replace(/[^A-Za-z0-9_]/g, "");
  store.delete(sanitizedKey);
  const filePath = path.join(SECRETS_DIR, `${sanitizedKey}.enc`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Parse a "CRED KEY=value" message and store the credential.
 * Returns the key name on success, null otherwise.
 * @param {string} message raw WhatsApp text
 * @returns {string|null}
 */
export function parseAndStoreCredential(message) {
  const match = message.match(/^CRED\s+([A-Za-z0-9_]+)=(.+)$/s);
  if (!match) return null;
  const [, key, value] = match;
  setCredential(key, value.trim());
  return key;
}

/**
 * Build an env-var object from stored credentials for injection into containers.
 * @param {string[]} keys  List of credential names needed.
 * @returns {object}
 */
export function buildEnvObject(keys) {
  const envObj = {};
  for (const key of keys) {
    const val = getCredential(key);
    if (val) envObj[key] = val;
  }
  return envObj;
}

/**
 * Sweep expired credentials (called periodically).
 */
export function sweepExpired() {
  for (const [key, entry] of store) {
    if (Date.now() > entry.expiresAt) {
      deleteCredential(key);
      logger.info(`credential-manager: swept expired credential [${key}]`);
    }
  }
  // Also sweep disk
  if (fs.existsSync(SECRETS_DIR)) {
    for (const file of fs.readdirSync(SECRETS_DIR)) {
      if (!file.endsWith(".enc")) continue;
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(SECRETS_DIR, file), "utf8")
        );
        if (Date.now() > data.expiresAt) {
          fs.unlinkSync(path.join(SECRETS_DIR, file));
        }
      } catch {
        // Corrupted file – remove
        fs.unlinkSync(path.join(SECRETS_DIR, file));
      }
    }
  }
}
