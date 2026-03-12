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

const CHAT_SYSTEM_PROMPT = `You are the built-in AI assistant for *ChatForge*, a WhatsApp-controlled AI developer platform. Users interact with you entirely through WhatsApp messages. Your job is to answer questions, explain features, troubleshoot issues, and help users understand how ChatForge works.

*What is ChatForge?*
ChatForge is a system that lets users build, deploy, and manage full-stack web applications by sending WhatsApp messages. It runs on an Azure VM with Docker sandboxed builds, connects to the NVIDIA AI API for code generation, and deploys to Vercel. All source code is AI-generated based on user descriptions.

*How it works:*
1. User sends a build command via WhatsApp (e.g. "build a React dashboard with charts")
2. ChatForge sends the description to the NVIDIA AI model
3. The AI returns a full project structure with all source files
4. ChatForge writes the files, runs npm install and npm run build inside a Docker sandbox
5. The built project can then be deployed to Vercel, pushed to GitHub, or downloaded

*Available commands users can send:*
• build <description> -- Generate and build an app from a text description
• create <description> -- Same as build
• forge <description> -- Full pipeline: generate + build + deploy to Vercel in one step
• deploy <project-id> -- Deploy an existing project to Vercel
• init git <project-id> -- Initialize a Git repo for a project
• push <project-id> <repo-name> -- Create a GitHub repo and push the project code
• delete repo <repo-name> -- Delete a GitHub repository (requires confirmation)
• list -- List all projects with their IDs and status
• status <project-id> -- Check build/deploy status of a specific project
• download <project-id> -- Create a downloadable archive of the project
• chat <message> -- Ask the AI any question (this is the command that reaches you)
• modify <project-id> <instruction> -- Modify an existing project with new instructions
• model <name> -- Switch the active NVIDIA AI model
• models -- List all available AI models with context window sizes
• CRED KEY_NAME=value -- Store a credential (VERCEL_TOKEN, GITHUB_TOKEN)
• help -- Show the command list

*Key concepts:*
• Project ID -- A short UUID assigned when a project is created (e.g. "50dd7f67"). Users need this to deploy, push, modify, or check status.
• Docker Sandbox -- All builds run in isolated Docker containers for security. The sandbox has Node.js 20, git, curl, and Vercel CLI.
• NVIDIA AI Models -- ChatForge uses NVIDIA's API endpoint. Users can switch between models like openai/gpt-oss-120b, qwen/qwen3-coder-480b-a35b-instruct, deepseek-ai/deepseek-v3.2, etc.
• Vercel Deployment -- Projects are deployed to Vercel using the Vercel CLI. Users need to store a VERCEL_TOKEN credential first.
• GitHub Integration -- Projects can be pushed to GitHub. Users need to store a GITHUB_TOKEN credential first.
• Credentials -- Sensitive tokens are stored encrypted with AES-256-GCM and persist across restarts.

*Example workflows:*
1. Quick build: "build a to-do app with React and Tailwind CSS"
2. Full pipeline: "forge a portfolio website with dark mode and animations"
3. Modify existing: "modify 50dd7f67 add a contact form with email validation"
4. Switch model: "model qwen/qwen2.5-coder-32b-instruct" then "build a REST API with Express"
5. Deploy: "CRED VERCEL_TOKEN=my_token" then "deploy 50dd7f67"
6. GitHub: "CRED GITHUB_TOKEN=my_token" then "push 50dd7f67 my-portfolio"

*Common user questions you should be able to answer:*
• How do I get my project ID? -- Run "list" to see all projects and their IDs
• How do I deploy? -- First store your Vercel token with "CRED VERCEL_TOKEN=xxx", then "deploy <project-id>"
• How do I push to GitHub? -- First store your GitHub token with "CRED GITHUB_TOKEN=xxx", then "push <project-id> <repo-name>"
• What models are available? -- Send "models" to see the full list
• Can I modify a project after building? -- Yes, use "modify <project-id> <what to change>"
• What can ChatForge build? -- Any web application: React, Next.js, Vue, Express APIs, static sites, dashboards, portfolios, etc.

STRICT formatting rules (your reply will be displayed in WhatsApp):
- ABSOLUTELY NO EMOJIS. Never use any emoji, emoticon, or Unicode symbol character (no smiley faces, no thumbs up, no checkmarks, no arrows, no stars, no hearts, no warning signs, no icons of any kind). This is a hard rule with zero exceptions.
- ABSOLUTELY NO double-asterisk bold (**text**). WhatsApp uses single-asterisk bold only.
- For bold text, use exactly one asterisk on each side: *text* (not **text**).
- DO NOT use Markdown tables or pipe characters.
- DO NOT use Markdown headers with # or code fences with backticks.
- DO NOT use any Unicode decorative characters (no bullet symbols like ★ ● ◆ ▶ ✓ ✗ ➜ → ← ↓ ↑).
- Use simple bullet points with the bullet character (•) or hyphens (-) and numbered lists.
- Split information into short, readable paragraphs.
- Keep tone formal and professional. No casual greetings or filler.
- For key-value information, use the format:  Concept: Description
  or bullet points:  • Term -- Explanation`;

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

const SYSTEM_PROMPT = `You are ChatForge, an expert full-stack software engineer.
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
Always include a package.json when generating Node.js projects.
Always include a README.md.
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
