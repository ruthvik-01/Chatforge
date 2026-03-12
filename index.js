// index.js – ChatForge entry point
import app from "./server/webhook-server.js";
import env from "./config/env-loader.js";
import logger from "./server/logger.js";
import { ensureSandboxImage } from "./server/docker-runner.js";
import { sweepExpiredProjects } from "./server/workspace-manager.js";
import { sweepExpired as sweepExpiredCreds } from "./server/credential-manager.js";

async function main() {
  logger.info("ChatForge starting…", { nodeEnv: env.NODE_ENV });

  // Pull Docker sandbox image if needed
  try {
    await ensureSandboxImage();
  } catch (err) {
    logger.warn("Could not pull sandbox image (Docker may not be available)", {
      error: err.message,
    });
  }

  // Start HTTP server
  app.listen(env.PORT, "0.0.0.0", () => {
    logger.info(`ChatForge webhook server listening on port ${env.PORT}`);
  });

  // Periodic cleanup: sweep expired projects and credentials every hour
  setInterval(() => {
    try {
      sweepExpiredProjects();
      sweepExpiredCreds();
    } catch (err) {
      logger.error("Sweep error", { error: err.message });
    }
  }, 60 * 60 * 1000);

  // Graceful shutdown
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      logger.info(`Received ${signal}, shutting down…`);
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: err.message, stack: err.stack });
  process.exit(1);
});
