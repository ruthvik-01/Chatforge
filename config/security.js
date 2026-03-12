// config/security.js – Shared security helpers
import crypto from "crypto";
import env from "./env-loader.js";

/** Blocked shell patterns – the sandbox runner rejects commands matching these. */
export const BLOCKED_PATTERNS = [
  /rm\s+(-[rRf]+\s+)*\//,          // rm -rf /
  /shutdown/i,
  /reboot/i,
  /mkfs/i,
  /dd\s+if=/i,
  /:\(\)\{.*\|.*&.*\};:/,           // fork bomb
  />\s*\/dev\/sd/i,
  /chmod\s+(-[rR]\s+)*777\s+\//,
  /curl\s+.*\|\s*(ba)?sh/i,         // pipe-to-shell
  /wget\s+.*\|\s*(ba)?sh/i,
];

/**
 * Returns true when a command string contains any blocked pattern.
 */
export function isCommandBlocked(command) {
  return BLOCKED_PATTERNS.some((re) => re.test(command));
}

/**
 * Verify the x-hub-signature-256 header sent by Meta (WhatsApp Cloud API).
 * @param {Buffer} rawBody  The raw request body bytes.
 * @param {string} signature  The value of the x-hub-signature-256 header.
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!signature) return false;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", env.WHATSAPP_APP_SECRET)
      .update(rawBody)
      .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature)
  );
}

/**
 * Mask secrets in a string (for logging).  Replaces anything that looks like
 * a token/key with asterisks.
 */
export function maskSecrets(text) {
  if (!text) return text;
  // Mask common token/key patterns (long alphanumeric strings ≥20 chars)
  return text.replace(
    /(?:token|key|secret|password|cred|api_key|apikey)[\s=:]+\S{6,}/gi,
    (match) => {
      const eqIdx = match.search(/[=:]\s*/);
      if (eqIdx === -1) return match.slice(0, 8) + "****";
      return match.slice(0, eqIdx + 1) + "****";
    }
  );
}
