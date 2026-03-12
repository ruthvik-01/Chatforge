// server/webhook-server.js – WhatsApp Cloud API webhook + Express server
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import env from "../config/env-loader.js";
import { verifyWebhookSignature } from "../config/security.js";
import { handleCommand, setSendReply } from "./agent-controller.js";
import { downloadTokens } from "./download-manager.js";
import logger from "./logger.js";
import axios from "axios";

const app = express();

// Trust reverse proxy (ngrok / nginx) so rate-limiter reads the real client IP
app.set("trust proxy", 1);

// ── Security middleware ──
app.use(helmet());
app.use(
  rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Keep raw body for signature verification, then parse JSON
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
    limit: "1mb",
  })
);

// ── WhatsApp message sender ──

/**
 * Send a text message back to a WhatsApp user.
 * @param {string} to  Phone number (without +).
 * @param {string} text  Message body.
 */
async function sendWhatsAppMessage(to, text) {
  // WhatsApp has a 4096 character limit per message
  const MAX_LEN = 4000;
  const chunks =
    text.length <= MAX_LEN
      ? [text]
      : text.match(new RegExp(`[\\s\\S]{1,${MAX_LEN}}`, "g")) || [text];

  for (const chunk of chunks) {
    try {
      await axios.post(
        `https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { body: chunk },
        },
        {
          headers: {
            Authorization: `Bearer ${env.WHATSAPP_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          timeout: 15_000,
        }
      );
    } catch (err) {
      logger.error("webhook-server: failed to send WhatsApp message", {
        error: err.message,
      });
    }
  }
}

// Wire up the agent controller's reply function
setSendReply(sendWhatsAppMessage);

// ── Webhook Verification (GET) ──
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN) {
    logger.info("webhook-server: webhook verified");
    return res.status(200).send(challenge);
  }

  logger.warn("webhook-server: webhook verification failed");
  return res.sendStatus(403);
});

// ── Incoming Messages (POST) ──
app.post("/webhook", async (req, res) => {
  // Always respond 200 quickly to acknowledge receipt
  res.sendStatus(200);

  // Verify signature
  const signature = req.headers["x-hub-signature-256"];
  if (!verifyWebhookSignature(req.rawBody, signature)) {
    logger.warn("webhook-server: invalid webhook signature");
    return;
  }

  // Extract messages
  const entry = req.body?.entry;
  if (!entry) return;

  for (const e of entry) {
    const changes = e.changes || [];
    for (const change of changes) {
      const messages = change.value?.messages;
      if (!messages) continue;

      for (const msg of messages) {
        // Only process text messages
        if (msg.type !== "text") continue;

        const senderPhone = msg.from;
        const text = msg.text?.body;

        if (!text) continue;

        // Authorization: only allow the owner
        if (senderPhone !== env.OWNER_PHONE_NUMBER) {
          logger.warn("webhook-server: unauthorized sender", {
            from: senderPhone,
          });
          await sendWhatsAppMessage(
            senderPhone,
            "Unauthorized. This bot only responds to the registered owner."
          );
          continue;
        }

        logger.info("webhook-server: received command", {
          from: senderPhone,
          messageLength: text.length,
        });

        // Process command asynchronously (don't block webhook response)
        handleCommand(senderPhone, text).catch((err) => {
          logger.error("webhook-server: unhandled command error", {
            error: err.message,
          });
        });
      }
    }
  }
});

// ── One-time file download ──
// :filename is cosmetic (makes URL end in .zip) – token is the real key
app.get("/download/:token/:filename?", (req, res) => {
  const entry = downloadTokens.get(req.params.token);

  if (!entry) {
    logger.warn("webhook-server: download – unknown token");
    return res.status(404).send("Not found or link expired.");
  }
  if (entry.used) {
    logger.warn("webhook-server: download – token already used");
    return res.status(410).send("This link has already been used.");
  }
  if (Date.now() > entry.expiresAt) {
    downloadTokens.delete(req.params.token);
    logger.warn("webhook-server: download – token expired");
    return res.status(410).send("Link expired.");
  }
  if (!fs.existsSync(entry.filePath)) {
    downloadTokens.delete(req.params.token);
    logger.warn("webhook-server: download – file not found on disk", { filePath: entry.filePath });
    return res.status(404).send("File not found.");
  }

  // Mark as used before sending so a second request in-flight is also rejected
  entry.used = true;
  const filename = path.basename(entry.filePath);
  logger.info("webhook-server: serving download", { filename });

  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/zip");
  const stream = fs.createReadStream(entry.filePath);
  stream.on("close", () => downloadTokens.delete(req.params.token));
  stream.pipe(res);
});

// ── Health Check ──
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "chatforge",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default app;
export { sendWhatsAppMessage };
