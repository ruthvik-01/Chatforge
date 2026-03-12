// config/env-loader.js – Loads and validates environment variables
import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, "..", ".env") });

/** Required environment variables – startup fails if any are missing. */
const REQUIRED = [
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_API_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_APP_SECRET",
  "OWNER_PHONE_NUMBER",
  "NVIDIA_API_KEY",
  "ENCRYPTION_KEY",
];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `[ChatForge] Fatal – missing required env vars: ${missing.join(", ")}`
  );
  process.exit(1);
}

const env = Object.freeze({
  // Server
  PORT: parseInt(process.env.PORT || "3000", 10),
  NODE_ENV: process.env.NODE_ENV || "production",

  // WhatsApp
  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
  WHATSAPP_API_TOKEN: process.env.WHATSAPP_API_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
  WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,

  // Authorization
  OWNER_PHONE_NUMBER: process.env.OWNER_PHONE_NUMBER,

  // NVIDIA AI
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
  NVIDIA_API_URL:
    process.env.NVIDIA_API_URL ||
    "https://integrate.api.nvidia.com/v1/chat/completions",
  NVIDIA_MODEL: process.env.NVIDIA_MODEL || "meta/llama-3.1-405b-instruct",
  NVIDIA_MAX_TOKENS: parseInt(process.env.NVIDIA_MAX_TOKENS || "8192", 10),
  NVIDIA_TEMPERATURE: parseFloat(process.env.NVIDIA_TEMPERATURE || "0.2"),
  NVIDIA_TOP_P: parseFloat(process.env.NVIDIA_TOP_P || "0.95"),

  // Encryption
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,

  // Workspace
  WORKSPACE_DIR: process.env.WORKSPACE_DIR || "/workspace",
  PROJECT_RETENTION_DAYS: parseInt(
    process.env.PROJECT_RETENTION_DAYS || "7",
    10
  ),

  // Docker
  DOCKER_SANDBOX_IMAGE: process.env.DOCKER_SANDBOX_IMAGE || "node:20-slim",
  DOCKER_CPU_LIMIT: parseFloat(process.env.DOCKER_CPU_LIMIT || "1"),
  DOCKER_MEMORY_LIMIT: process.env.DOCKER_MEMORY_LIMIT || "512m",
  DOCKER_NETWORK_DISABLED: process.env.DOCKER_NETWORK_DISABLED === "true",

  // Vercel
  VERCEL_TOKEN: process.env.VERCEL_TOKEN || "",

  // GitHub
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",

  // Azure Key Vault (optional)
  AZURE_KEY_VAULT_URL: process.env.AZURE_KEY_VAULT_URL || "",
  AZURE_TENANT_ID: process.env.AZURE_TENANT_ID || "",
  AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID || "",
  AZURE_CLIENT_SECRET: process.env.AZURE_CLIENT_SECRET || "",

  // Azure Blob (optional)
  AZURE_STORAGE_CONNECTION_STRING:
    process.env.AZURE_STORAGE_CONNECTION_STRING || "",
  AZURE_STORAGE_CONTAINER:
    process.env.AZURE_STORAGE_CONTAINER || "chatforge-artifacts",

  // Credentials
  CREDENTIAL_TTL_SECONDS: parseInt(
    process.env.CREDENTIAL_TTL_SECONDS || "604800",
    10
  ),

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  LOG_DIR: process.env.LOG_DIR || "/logs",
});

export default env;
