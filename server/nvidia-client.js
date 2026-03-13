// server/nvidia-client.js – NVIDIA AI API client for code generation & chat
import axios from "axios";
import env from "../config/env-loader.js";
import logger from "./logger.js";

// Dynamic model – mutable at runtime via WhatsApp "model" command
let currentModel = env.NVIDIA_MODEL;

// Cumulative token usage tracker (resets on process restart)
const usageStats = {
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalRequests: 0,
  byModel: {},  // { [modelName]: { promptTokens, completionTokens, requests } }
  since: new Date().toISOString(),
};

/**
 * Record token usage from an API response.
 * @param {object} usage  The `usage` object from the NVIDIA API response.
 * @param {string} model  The model name used.
 */
function trackUsage(usage, model) {
  if (!usage) return;
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  usageStats.totalPromptTokens += prompt;
  usageStats.totalCompletionTokens += completion;
  usageStats.totalRequests += 1;
  if (!usageStats.byModel[model]) {
    usageStats.byModel[model] = { promptTokens: 0, completionTokens: 0, requests: 0 };
  }
  usageStats.byModel[model].promptTokens += prompt;
  usageStats.byModel[model].completionTokens += completion;
  usageStats.byModel[model].requests += 1;
  logger.info("nvidia-client: token usage", { model, prompt, completion, total: prompt + completion });
}

/**
 * Return a snapshot of cumulative token usage since process start.
 * @returns {object}
 */
export function getUsageStats() {
  return {
    ...usageStats,
    totalTokens: usageStats.totalPromptTokens + usageStats.totalCompletionTokens,
  };
}

/**
 * Sanitize AI response for WhatsApp:
 * - Convert Markdown double-asterisk bold (**text**) to WhatsApp single-asterisk bold (*text*)
 * - Strip all emoji / emoticon / symbol Unicode characters
 * - Remove Markdown headers (# lines) and code fences
 */
function sanitizeForWhatsApp(text) {
  let out = text;
  // Convert **bold** → *bold*  (handles nested like ***bold*** → *bold* too)
  out = out.replace(/\*{2,}([^*]+?)\*{2,}/g, "*$1*");
  // Remove Markdown headers: lines starting with one or more #
  out = out.replace(/^#{1,6}\s+/gm, "");
  // Remove code fences
  out = out.replace(/```[\s\S]*?```/g, (match) => {
    // Keep the content inside fences, just remove the fence markers
    return match.replace(/^```\w*\n?/gm, "").replace(/\n?```$/gm, "");
  });
  // Strip emoji and miscellaneous symbol Unicode ranges
  out = out.replace(/[\u{1F600}-\u{1F64F}]/gu, "");  // Emoticons
  out = out.replace(/[\u{1F300}-\u{1F5FF}]/gu, "");  // Misc Symbols & Pictographs
  out = out.replace(/[\u{1F680}-\u{1F6FF}]/gu, "");  // Transport & Map
  out = out.replace(/[\u{1F1E0}-\u{1F1FF}]/gu, "");  // Flags
  out = out.replace(/[\u{2600}-\u{26FF}]/gu, "");    // Misc symbols
  out = out.replace(/[\u{2700}-\u{27BF}]/gu, "");    // Dingbats
  out = out.replace(/[\u{FE00}-\u{FE0F}]/gu, "");    // Variation Selectors
  out = out.replace(/[\u{1F900}-\u{1F9FF}]/gu, "");  // Supplemental Symbols
  out = out.replace(/[\u{1FA00}-\u{1FA6F}]/gu, "");  // Chess Symbols
  out = out.replace(/[\u{1FA70}-\u{1FAFF}]/gu, "");  // Symbols Extended-A
  out = out.replace(/[\u{200D}]/gu, "");              // Zero Width Joiner
  out = out.replace(/[\u{20E3}]/gu, "");              // Combining Enclosing Keycap
  out = out.replace(/[\u{E0020}-\u{E007F}]/gu, "");   // Tags
  // Clean up leftover double-spaces from stripped emojis
  out = out.replace(/ {2,}/g, " ");
  // Clean up blank lines left by stripping
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

const CHAT_SYSTEM_PROMPT = `You are ChatForge AI.

ChatForge is a WhatsApp-controlled AI DevOps assistant that generates, modifies, debugs, and deploys software projects.

Act like a senior software engineer and DevOps engineer combined.

Your goals:
- Ensure generated projects run successfully.
- Keep errors minimal.
- Keep deployment simple.

Core commands users send:
- build <description>
- create <description>
- forge <description>
- debug <project-id>
- fix <project-id>
- modify <project-id> <instruction>
- deploy <project-id>
- init git <project-id>
- push <project-id> <repo-name>
- list
- status <project-id>
- download <project-id>
- chat <message>
- model <name>
- models
- usage
- CRED KEY=value

Project generation policy:
- Build/create/forge should produce a valid structure, package.json, dependencies, and runnable output.
- Do not hardcode credentials.
- Use environment variables for secrets.

When users ask for help:
- Explain exact commands to run.
- Keep output copy-friendly and concise.
- If a command needs credentials, show CRED KEY=value examples.

Formatting constraints for WhatsApp output:
- No emojis.
- No markdown tables.
- No code fences.
- Keep responses short and structured with clear sections.
- Prefer simple bullets and numbered steps.

If you mention models, include the active model name when possible.

If a user asks about project actions without an ID, remind them they can use the latest project shortcut in ChatForge.`;

export function setModel(name) {
  currentModel = name;
}

export function getModel() {
  return currentModel;
}

/**
 * Conversational AI chat – no code-generation pipeline.
 * @param {string} userPrompt  The user's question.
 * @returns {Promise<string>}  Plain-text AI reply.
 */
export async function chatWithAI(userPrompt) {
  logger.info("nvidia-client: sending chat request", {
    promptLength: userPrompt.length,
    model: currentModel,
  });

  let response;
  try {
    response = await axios.post(
      env.NVIDIA_API_URL,
      {
        model: currentModel,
        messages: [
          { role: "system", content: CHAT_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: env.NVIDIA_MAX_TOKENS,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 600_000,
      }
    );
  } catch (err) {
    logger.error("nvidia-client: chat request failed", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    throw new Error(
      `NVIDIA API error: ${err.response?.data?.error?.message || err.message}`
    );
  }

  const text = response.data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("NVIDIA API returned empty chat response.");
  }

  trackUsage(response.data?.usage, currentModel);

  const cleaned = sanitizeForWhatsApp(text);

  logger.info("nvidia-client: chat response received", {
    responseLength: cleaned.length,
  });
  return cleaned;
}

/**
 * Send a modification request with project context to the AI.
 * @param {string} instruction  What the user wants changed.
 * @param {Record<string, string>} existingFiles  Current project files.
 * @returns {Promise<object>}  Parsed project structure (same shape as generateCode).
 */
export async function modifyProject(instruction, existingFiles) {
  const fileContext = Object.entries(existingFiles)
    .map(([p, c]) => `--- ${p} ---\n${c}`)
    .join("\n\n");

  const modifyPrompt = `You are ChatForge, an expert full-stack software engineer.
Below is the current project source code.
The user wants the following modification applied:

"${instruction}"

Current project files:
${fileContext}

Respond ONLY with a valid JSON object containing ALL project files (modified and unmodified).
The JSON must have this exact structure:
{
  "files": {
    "relative/path/to/file.ext": "file content as a string",
    ...
  },
  "buildCommand": "npm install && npm run build",
  "startCommand": "npm start",
  "framework": "detected framework name",
  "description": "short description of the modification"
}
Do NOT wrap the JSON in markdown code fences. Return raw JSON only.`;

  logger.info("nvidia-client: sending modify request", {
    instructionLength: instruction.length,
    fileCount: Object.keys(existingFiles).length,
    model: currentModel,
  });

  let response;
  try {
    response = await axios.post(
      env.NVIDIA_API_URL,
      {
        model: currentModel,
        messages: [
          { role: "system", content: modifyPrompt },
          { role: "user", content: instruction },
        ],
        temperature: env.NVIDIA_TEMPERATURE,
        top_p: env.NVIDIA_TOP_P,
        max_tokens: env.NVIDIA_MAX_TOKENS,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 600_000,
      }
    );
  } catch (err) {
    logger.error("nvidia-client: modify request failed", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    throw new Error(
      `NVIDIA API error: ${err.response?.data?.error?.message || err.message}`
    );
  }

  const raw = response.data?.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error("NVIDIA API returned empty modify response.");
  }

  trackUsage(response.data?.usage, currentModel);

  const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  let project;
  try {
    project = JSON.parse(cleaned);
  } catch {
    throw new Error("AI modification response was not valid JSON.");
  }

  if (!project.files || typeof project.files !== "object") {
    throw new Error("AI response missing 'files' object.");
  }

  return project;
}

const SYSTEM_PROMPT = `You are ChatForge, an expert full-stack software engineer and DevOps engineer.
When asked to generate an application, respond ONLY with a valid JSON object.
The JSON must have this exact structure:
{
  "files": {
    "relative/path/to/file.ext": "file content as a string",
    ...
  },
  "buildCommand": "npm install && npm run build",
  "startCommand": "npm start",
  "framework": "detected framework name",
  "description": "short project description"
}
Do NOT wrap the JSON in markdown code fences. Return raw JSON only.
Generate complete, production-quality code with proper error handling.
Prioritize code that builds successfully with minimal configuration errors.
Always include a package.json when generating Node.js projects.
Always include a README.md.
Ensure package scripts are valid and include at least build and dev/start commands where relevant.
Always include a vercel.json file configured for the framework you use:
  - For Vite/Vue/Svelte projects: { "outputDirectory": "dist", "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
  - For Create React App: { "outputDirectory": "build", "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
  - For Next.js projects: { "framework": "nextjs" }
  - For static sites with no build: { "outputDirectory": "." }
This is critical -- without vercel.json, deployments will fail.`;

/**
 * Call the NVIDIA AI API to generate application code.
 * @param {string} userPrompt  The user's natural-language request.
 * @returns {Promise<object>}  Parsed project structure.
 */
export async function generateCode(userPrompt) {
  logger.info("nvidia-client: sending code generation request", {
    promptLength: userPrompt.length,
    model: currentModel,
  });

  let response;
  try {
    response = await axios.post(
      env.NVIDIA_API_URL,
      {
        model: currentModel,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: env.NVIDIA_TEMPERATURE,
        top_p: env.NVIDIA_TOP_P,
        max_tokens: env.NVIDIA_MAX_TOKENS,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 600_000, // 10 minutes for large models
      }
    );
  } catch (err) {
    logger.error("nvidia-client: NVIDIA API request failed", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    throw new Error(
      `NVIDIA API error: ${err.response?.data?.error?.message || err.message}`
    );
  }

  const raw = response.data?.choices?.[0]?.message?.content;
  if (!raw) {
    logger.error("nvidia-client: empty response from API", {
      data: response.data,
    });
    throw new Error("NVIDIA API returned empty response.");
  }

  trackUsage(response.data?.usage, currentModel);

  logger.info("nvidia-client: received response", {
    responseLength: raw.length,
    model: response.data?.model,
  });

  // Try to parse JSON – strip markdown fences if the model wrapped it anyway
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");

  let project;
  try {
    project = JSON.parse(cleaned);
  } catch {
    logger.error("nvidia-client: failed to parse AI response as JSON");
    throw new Error("AI response was not valid JSON. Raw output logged.");
  }

  if (!project.files || typeof project.files !== "object") {
    throw new Error("AI response missing 'files' object.");
  }

  return project;
}
