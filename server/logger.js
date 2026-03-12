// server/logger.js – Structured Winston logger with secret masking
import winston from "winston";
import path from "path";
import fs from "fs";
import env from "../config/env-loader.js";
import { maskSecrets } from "../config/security.js";

const logDir = env.LOG_DIR;
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

/** Custom format that masks secrets from every log message + metadata. */
const secretMask = winston.format((info) => {
  if (typeof info.message === "string") {
    info.message = maskSecrets(info.message);
  }
  // Mask meta fields
  for (const key of Object.keys(info)) {
    if (key === "level" || key === "message" || key === "timestamp") continue;
    if (typeof info[key] === "string") {
      info[key] = maskSecrets(info[key]);
    }
  }
  return info;
});

const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    secretMask(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "chatforge" },
  transports: [
    new winston.transports.File({
      filename: path.join(logDir, "error.log"),
      level: "error",
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logDir, "combined.log"),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
});

// Also log to console in non-production environments
if (env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    })
  );
} else {
  // In production, still add a minimal console transport for Docker log drivers
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        secretMask(),
        winston.format.json()
      ),
    })
  );
}

export default logger;
