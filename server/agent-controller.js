// server/agent-controller.js – OpenClaw-style AI agent that orchestrates the full workflow
import { generateCode, chatWithAI, modifyProject, setModel, getModel, getUsageStats } from "./nvidia-client.js";
import fs from "fs";
import path from "path";
import { createDownloadToken } from "./download-manager.js";
import {
  createProject,
  writeFiles,
  updateMetadata,
  getMetadata,
  getSourceDir,
  archiveProject,
  listProjects,
} from "./workspace-manager.js";
import { runInSandbox } from "./docker-runner.js";
import { initAndCommit, createAndPush, deleteRepo } from "./git-manager.js";
import { deployToVercel, connectVercelToGitHub } from "./deploy-vercel.js";
import { getCredential, buildEnvObject } from "./credential-manager.js";
import env from "../config/env-loader.js";
import logger from "./logger.js";

/**
 * Send a WhatsApp reply. This import is deferred to avoid circular deps;
 * the webhook-server sets it at startup.
 */
/**
 * Helper to convert standard Markdown to WhatsApp's formatting
 */
function formatWhatsAppText(text) {
  if (!text) return text;
  let formatted = text;
  // Convert standard markdown bold **text** to WhatsApp bold *text*
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '*$1*');
  // Convert standard markdown bold __text__ to WhatsApp bold *text*
  formatted = formatted.replace(/__(.*?)__/g, '*$1*');
  // Convert markdown headers # heading to bold *heading*
  formatted = formatted.replace(/^#{1,6}\s+(.*)$/gm, '*$1*');
  // Remove language tags from code blocks
  formatted = formatted.replace(/```[a-zA-Z0-9-]+\n/g, '```\n');
  // Convert markdown links [text](url) to text: url
  formatted = formatted.replace(/\[(.*?)\]\((.*?)\)/g, '$1: $2');
  return formatted;
}

let sendReply = async () => {};
export function setSendReply(fn) {
  sendReply = async (to, text) => {
    let content = String(text || "");
    content = formatWhatsAppText(content);

    try {
      // Send status and quick-copy as separate WhatsApp messages for readability.
      if (content.includes("\n\nQuick Copy:\n")) {
        const [first, ...rest] = content.split("\n\nQuick Copy:\n");
        const quickCopy = rest.join("\n\nQuick Copy:\n");

        if (first.trim()) {
          await fn(to, first.trim());
        }
        if (quickCopy.trim()) {
          await fn(to, `Quick Copy:\n${quickCopy.trim()}`);
        }
        return;
      }

      await fn(to, content);
    } catch (err) {
      logger.error("agent-controller: sendReply failed", {
        to,
        error: err.message,
      });
    }
  };
}

// Pending deletion confirmations: Map<phone, { repoName, expiresAt }>
const pendingDeletes = new Map();
// Most recent project per user phone for project-id shortcuts.
const latestProjectByPhone = new Map();

// ──── Per-project concurrency locks ────
// Prevents two mutating operations (build, deploy, modify, push, connect) from
// running on the same project simultaneously. Non-project commands (chat, list,
// help, status, models) are never blocked.
const projectLocks = new Map();

function setLatestProjectForPhone(phone, projectId) {
  if (!phone || !projectId) return;
  latestProjectByPhone.set(phone, projectId);
}

function getLatestProjectForPhone(phone) {
  return latestProjectByPhone.get(phone) || null;
}

function formatQuickCopy(statusMessage, projectId = null) {
  const model = getModel();
  const text = String(statusMessage || "").trim();
  const lower = text.toLowerCase();

  // Keep in-progress updates short and clean.
  const isProgress = [
    "starting",
    "generating",
    "building",
    "deploying",
    "analyzing",
    "applying",
    "thinking",
    "creating",
    "initializing",
    "pushing",
    "redeploying",
  ].some((k) => lower.includes(k));

  if (isProgress) {
    return text;
  }

  const isImportant = [
    "succeeded",
    "complete",
    "failed",
    "not found",
    "requires",
    "debug scan",
    "auto-fix",
    "usage",
    "invalid format",
    "unknown command",
  ].some((k) => lower.includes(k));

  if (!isImportant) {
    return text;
  }

  const projectLine = projectId ? `Project ID: ${projectId}` : "Project ID: pending";

  return [
    text,
    "",
    `*${projectLine}*`,
    `*Current Model:* ${model}`,
  ].join("\n");
}

function parseOptionalProjectId(text, command) {
  const rest = text.replace(new RegExp(`^${command}\\s*`, "i"), "").trim();
  return rest || null;
}

function parseModifyCommand(text) {
  const rest = text.replace(/^modify\s+/i, "").trim();
  if (!rest) return { projectId: null, instruction: "" };

  const firstSpace = rest.indexOf(" ");
  if (firstSpace === -1) {
    return { projectId: rest, instruction: "" };
  }

  const firstToken = rest.slice(0, firstSpace).trim();
  const remaining = rest.slice(firstSpace + 1).trim();

  // Support shorthand: "modify <instruction>" uses latest project.
  if (firstToken.startsWith("project-") || /^[0-9a-f-]{8,}$/.test(firstToken)) {
    return { projectId: firstToken, instruction: remaining };
  }

  return { projectId: null, instruction: rest };
}

function readPackageJson(sourceDir) {
  try {
    const pkgPath = path.join(sourceDir, "package.json");
    if (!fs.existsSync(pkgPath)) return null;
    return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
}

function buildDiagnosticIssues(logText) {
  const issues = [];
  const lines = String(logText || "").split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;

    const pathMatch = line.match(/([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+):(\d+)(?::\d+)?\s*-?\s*(.*)$/);
    if (pathMatch) {
      const file = pathMatch[1].replace(/^\.\//, "");
      const lineNo = pathMatch[2];
      const problem = pathMatch[3] || "Build or syntax error";
      let cause = "framework configuration error";
      const lc = problem.toLowerCase();
      if (lc.includes("cannot find module") || lc.includes("module not found")) cause = "missing dependency or invalid import path";
      if (lc.includes("ts") || lc.includes("typescript")) cause = "typescript error";
      if (lc.includes("env") || lc.includes("process.env")) cause = "environment variable issue";
      issues.push({ file, line: lineNo, problem, cause });
      continue;
    }

    const depMatch = line.match(/Cannot find module ['"]([^'"]+)['"]/i) || line.match(/Module not found.*['"]([^'"]+)['"]/i);
    if (depMatch) {
      issues.push({
        file: "unknown",
        line: "unknown",
        problem: `Missing package: ${depMatch[1]}`,
        cause: "missing dependency",
      });
    }
  }

  return issues;
}

function detectExternalRequirements(prompt) {
  const p = String(prompt || "").toLowerCase();
  const checks = [
    {
      test: /firebase/.test(p),
      service: "Firebase",
      creds: ["FIREBASE_API_KEY", "FIREBASE_PROJECT_ID"],
      options: ["Firebase", "Supabase", "MongoDB Atlas"],
    },
    {
      test: /supabase|postgres/.test(p),
      service: "Database",
      creds: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
      options: ["Supabase", "Neon", "Azure Database for PostgreSQL"],
    },
    {
      test: /mongodb|mongo/.test(p),
      service: "MongoDB Atlas",
      creds: ["MONGODB_URI"],
      options: ["MongoDB Atlas", "Cosmos DB Mongo API"],
    },
    {
      test: /stripe|payment/.test(p),
      service: "Payments",
      creds: ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"],
      options: ["Stripe"],
    },
    {
      test: /openai|anthropic|claude|gemini/.test(p),
      service: "AI API",
      creds: ["OPENAI_API_KEY"],
      options: ["OpenAI", "Anthropic", "Azure OpenAI"],
    },
    {
      test: /mapbox|google maps|maps/.test(p),
      service: "Maps",
      creds: ["MAPS_API_KEY"],
      options: ["Google Maps", "Mapbox"],
    },
    {
      test: /email|sendgrid|mailgun|smtp/.test(p),
      service: "Email",
      creds: ["SENDGRID_API_KEY"],
      options: ["SendGrid", "Resend", "Mailgun"],
    },
  ];

  return checks.filter((c) => c.test);
}

async function resolveProjectIdOrReply(phone, providedProjectId, commandName) {
  const projectId = (providedProjectId || "").trim() || getLatestProjectForPhone(phone);
  if (projectId) return projectId;

  await sendReply(
    phone,
    formatQuickCopy(
      `${commandName} requires a project ID, and no recent project was found. Build first, or run: ${commandName} <project-id>`,
      null
    )
  );
  return null;
}

/**
 * Acquire a lock for a project. Returns true if acquired, false if already locked.
 * @param {string} projectId
 * @param {string} operation  Description of the operation (e.g. "deploy")
 * @returns {boolean}
 */
function acquireProjectLock(projectId, operation) {
  if (projectLocks.has(projectId)) return false;
  projectLocks.set(projectId, { operation, since: Date.now() });
  return true;
}

/**
 * Release a project lock.
 * @param {string} projectId
 */
function releaseProjectLock(projectId) {
  projectLocks.delete(projectId);
}

/**
 * Get the current lock info for a project.
 * @param {string} projectId
 * @returns {{ operation: string, since: number }|null}
 */
function getProjectLock(projectId) {
  return projectLocks.get(projectId) || null;
}

/**
 * Execute an async operation with a per-project lock.
 * If the project is already locked, notify the user and skip.
 * @param {string} phone       User phone for reply.
 * @param {string} projectId   The project being operated on.
 * @param {string} operation   Human-readable operation name.
 * @param {Function} fn        Async function to execute.
 */
async function withProjectLock(phone, projectId, operation, fn) {
  const existing = getProjectLock(projectId);
  if (existing) {
    const elapsed = Math.round((Date.now() - existing.since) / 1000);
    await sendReply(
      phone,
      `Project *${projectId}* is busy with *${existing.operation}* (${elapsed}s).\n\nPlease wait for it to finish, or run a different command.`
    );
    return;
  }

  acquireProjectLock(projectId, operation);
  try {
    await fn();
  } finally {
    releaseProjectLock(projectId);
  }
}

// ──────────── Command Router ────────────

/**
 * Process an incoming command from the authorized user.
 * @param {string} userPhone  Sender phone number.
 * @param {string} message    Raw message text.
 */
export async function handleCommand(userPhone, message) {
  const text = message.trim();
  const lower = text.toLowerCase();

  try {
    // ── Credential submission ──
    if (text.startsWith("CRED ")) {
      return await handleCredential(userPhone, text);
    }

    // ── Build / generate ──
    if (lower.startsWith("build ") || lower.startsWith("create ") || lower.startsWith("generate ")) {
      const prompt = text.replace(/^(build|create|generate)\s+/i, "");
      return await handleBuild(userPhone, prompt);
    }

    // ── Deploy ──
    if (lower === "deploy" || lower.startsWith("deploy ")) {
      const projectId = await resolveProjectIdOrReply(
        userPhone,
        parseOptionalProjectId(text, "deploy"),
        "deploy"
      );
      if (!projectId) return;
      return await withProjectLock(userPhone, projectId, "deploy", () =>
        handleDeploy(userPhone, projectId)
      );
    }

    // ── Debug ──
    if (lower === "debug" || lower.startsWith("debug ")) {
      const projectId = await resolveProjectIdOrReply(
        userPhone,
        parseOptionalProjectId(text, "debug"),
        "debug"
      );
      if (!projectId) return;
      return await withProjectLock(userPhone, projectId, "debug", () =>
        handleDebug(userPhone, projectId)
      );
    }

    // ── Auto fix ──
    if (lower === "fix" || lower.startsWith("fix ")) {
      const projectId = await resolveProjectIdOrReply(
        userPhone,
        parseOptionalProjectId(text, "fix"),
        "fix"
      );
      if (!projectId) return;
      return await withProjectLock(userPhone, projectId, "fix", () =>
        handleFix(userPhone, projectId)
      );
    }

    // ── Git init ──
    if (lower === "init git" || lower.startsWith("init git ")) {
      const projectId = await resolveProjectIdOrReply(
        userPhone,
        parseOptionalProjectId(text, "init git"),
        "init git"
      );
      if (!projectId) return;
      return await withProjectLock(userPhone, projectId, "git init", () =>
        handleGitInit(userPhone, projectId)
      );
    }

    // ── Push to GitHub ──
    if (lower.startsWith("push ")) {
      const parts = text.replace(/^push\s+/i, "").trim().split(/\s+/);
      const projectId = parts[0];
      const repoName = parts[1] || projectId;
      return await withProjectLock(userPhone, projectId, "push", () =>
        handleGitPush(userPhone, projectId, repoName)
      );
    }

    // ── Confirm delete repo ──
    if (lower.startsWith("confirm delete ")) {
      const repoName = text.replace(/^confirm delete\s+/i, "").trim();
      return await handleConfirmDelete(userPhone, repoName);
    }

    // ── Delete repo ──
    if (lower.startsWith("delete repo ")) {
      const repoName = text.replace(/^delete repo\s+/i, "").trim();
      return await handleDeleteRepo(userPhone, repoName);
    }

    // ── Download archive ──
    if (lower === "download" || lower.startsWith("download ")) {
      const projectId = await resolveProjectIdOrReply(
        userPhone,
        parseOptionalProjectId(text, "download"),
        "download"
      );
      if (!projectId) return;
      return await handleDownload(userPhone, projectId);
    }

    // ── List projects ──
    if (lower === "list" || lower === "projects") {
      return await handleList(userPhone);
    }

    // ── Status ──
    if (lower === "status" || lower.startsWith("status ")) {
      const projectId = await resolveProjectIdOrReply(
        userPhone,
        parseOptionalProjectId(text, "status"),
        "status"
      );
      if (!projectId) return;
      return await handleStatus(userPhone, projectId);
    }

    // ── AI Chat ──
    if (lower.startsWith("chat ")) {
      const userPrompt = text.replace(/^chat\s+/i, "");
      return await handleChat(userPhone, userPrompt);
    }

    // ── Modify existing project ──
    if (lower.startsWith("modify ")) {
      const parsed = parseModifyCommand(text);
      const projectId = await resolveProjectIdOrReply(userPhone, parsed.projectId, "modify");
      if (!projectId) return;
      const instruction = parsed.instruction;
      if (!instruction) {
        return await sendReply(
          userPhone,
          formatQuickCopy("Usage: modify <project-id> <instruction>", projectId)
        );
      }
      return await withProjectLock(userPhone, projectId, "modify", () =>
        handleModify(userPhone, projectId, instruction)
      );
    }

    // ── Token usage stats ──
    if (lower === "usage") {
      return await handleUsage(userPhone);
    }

    // ── List available models ──
    if (lower === "models") {
      return await handleModels(userPhone);
    }

    // ── Switch NVIDIA model ──
    if (lower.startsWith("model ")) {
      const newModel = text.replace(/^model\s+/i, "").trim();
      if (!newModel) {
        const current = getModel();
        return await sendReply(userPhone, formatQuickCopy(`Active Model:\n${current}`, getLatestProjectForPhone(userPhone)));
      }
      setModel(newModel);
      logger.info("agent-controller: model switched", { model: newModel });
      return await sendReply(userPhone, formatQuickCopy(`Active Model:\n${newModel}`, getLatestProjectForPhone(userPhone)));
    }

    // ── Help ──
    if (lower === "help") {
      return await handleHelp(userPhone);
    }

    // ── Connect Vercel to GitHub ──
    if (lower.startsWith("connect ")) {
      const rest = text.replace(/^connect\s+/i, "").trim();
      const parts = rest.split(/\s+/);
      const projectId = parts[0];
      const repoName = parts[1] || null;
      return await withProjectLock(userPhone, projectId, "connect", () =>
        handleConnect(userPhone, projectId, repoName)
      );
    }

    // ── Full pipeline: build + deploy ──
    if (lower.startsWith("forge ")) {
      const prompt = text.replace(/^forge\s+/i, "");
      return await handleForge(userPhone, prompt);
    }

    // ── Unknown command – treat as a build request ──
    await sendReply(userPhone, formatQuickCopy("Unknown command. Send help for available commands.", getLatestProjectForPhone(userPhone)));
  } catch (err) {
    logger.error("agent-controller: command error", {
      error: err.message,
      stack: err.stack,
    });
    await sendReply(userPhone, formatQuickCopy(`Error: ${err.message}\n\nSend help for assistance.`, getLatestProjectForPhone(userPhone)));
  }
}

// ──────────── Command Handlers ────────────

async function handleCredential(phone, text) {
  const { parseAndStoreCredential } = await import("./credential-manager.js");
  const key = parseAndStoreCredential(text);
  if (key) {
    await sendReply(phone, formatQuickCopy(`Credential stored securely: ${key}`, getLatestProjectForPhone(phone)));
  } else {
    await sendReply(phone, formatQuickCopy("Invalid format. Use: CRED KEY=value", getLatestProjectForPhone(phone)));
  }
}

async function handleBuild(phone, prompt) {
  const needs = detectExternalRequirements(prompt);
  if (needs.length > 0) {
    const missing = needs.filter((n) => n.creds.some((k) => !getCredential(k)));
    if (missing.length > 0) {
      const first = missing[0];
      const credExamples = first.creds.map((k) => `CRED ${k}=your_value`).join("\n");
      await sendReply(
        phone,
        formatQuickCopy(
          `External service required.\n\nThis project needs ${first.service}.\n\nRecommended options:\n${first.options.join("\n")}\n\nPlease provide credentials:\n${credExamples}\n\nGeneration will continue once credentials are provided.`,
          getLatestProjectForPhone(phone)
        )
      );
      return;
    }
  }

  await sendReply(phone, formatQuickCopy(`Starting build\n\nPrompt: ${prompt.slice(0, 200)}...`, getLatestProjectForPhone(phone)));

  // 1. Generate code
  const project = await generateCode(prompt);

  // 2. Create workspace
  const { projectId, sourceDir } = createProject();
  setLatestProjectForPhone(phone, projectId);
  writeFiles(sourceDir, project.files);

  // Always send project ID as a dedicated message for easy copy.
  await sendReply(phone, `Project ID:\n${projectId}`);

  await sendReply(phone, formatQuickCopy(`Project created with ${Object.keys(project.files).length} files. Running build...`, projectId));

  // 3. Build in sandbox
  const buildCmd = project.buildCommand || "npm install";
  const result = await runInSandbox({
    command: buildCmd,
    workDir: sourceDir,
    envVars: buildEnvObject(["NODE_ENV"]),
  });

  if (result.exitCode !== 0) {
    updateMetadata(projectId, { status: "build-failed" });
    await sendReply(phone, formatQuickCopy(`Build failed.\n\n${result.stderr.slice(0, 500)}`, projectId));
    return;
  }

  updateMetadata(projectId, {
    status: "built",
    framework: project.framework || "unknown",
    description: project.description || "",
  });

  await sendReply(phone, formatQuickCopy("Build succeeded.", projectId));

  logger.info("agent-controller: build completed", { projectId });
}

async function handleDeploy(phone, projectId) {
  setLatestProjectForPhone(phone, projectId);
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, formatQuickCopy("Project not found.", projectId));
  }

  // Check for Vercel token
  const token = getCredential("VERCEL_TOKEN");
  if (!token) {
    return await sendReply(phone, formatQuickCopy(`Deployment requires Vercel credentials.\n\nCRED VERCEL_TOKEN=your_token_here`, projectId));
  }

  await sendReply(phone, formatQuickCopy("Deploying to Vercel...", projectId));

  const sourceDir = getSourceDir(projectId);
  const url = await deployToVercel(sourceDir);
  updateMetadata(projectId, { status: "deployed", deploymentUrl: url });

  await sendReply(phone, formatQuickCopy(`Deployment succeeded.\n\nURL: ${url}`, projectId));

  logger.info("agent-controller: deploy completed", { projectId, url });
}

async function handleConnect(phone, projectId, repoNameOverride) {
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, `Project *${projectId}* not found.`);
  }

  // Need Vercel deployment URL
  if (!meta.deploymentUrl) {
    return await sendReply(
      phone,
      `Project *${projectId}* has not been deployed to Vercel yet.\n\nFirst deploy: *deploy ${projectId}*`
    );
  }

  // Need both tokens
  const vercelToken = getCredential("VERCEL_TOKEN");
  if (!vercelToken) {
    return await sendReply(
      phone,
      `Vercel token required.\n\nSend: CRED VERCEL_TOKEN=your_token`
    );
  }

  const githubToken = getCredential("GITHUB_TOKEN");
  if (!githubToken) {
    return await sendReply(
      phone,
      `GitHub token required.\n\nSend: CRED GITHUB_TOKEN=your_token`
    );
  }

  // Determine GitHub owner and repo name
  let githubOwner;
  let repoName;

  if (meta.githubUrl) {
    // Extract owner/repo from URL like https://github.com/owner/repo.git
    const match = meta.githubUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (match) {
      githubOwner = match[1];
      repoName = repoNameOverride || match[2];
    }
  }

  if (!githubOwner) {
    // Fetch owner from GitHub API using the token
    const axios = (await import("axios")).default;
    const userRes = await axios.get("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
      timeout: 15_000,
    });
    githubOwner = userRes.data.login;
  }

  if (!repoName) {
    return await sendReply(
      phone,
      `Could not determine GitHub repo.\n\nEither push first: *push ${projectId} repo-name*\nOr specify: *connect ${projectId} repo-name*`
    );
  }

  await sendReply(
    phone,
    `Connecting Vercel project to *${githubOwner}/${repoName}*...`
  );

  const result = await connectVercelToGitHub(
    meta.deploymentUrl,
    githubOwner,
    repoName
  );

  updateMetadata(projectId, { vercelGitConnected: true });

  await sendReply(
    phone,
    `*Vercel connected to GitHub!*\n\nVercel project: *${result.vercelProject}*\nGitHub repo: *${result.githubRepo}*\n\nFuture pushes to the *main* branch will trigger automatic Vercel deployments.`
  );

  logger.info("agent-controller: Vercel-GitHub connected", {
    projectId,
    repo: result.githubRepo,
  });
}

async function handleGitInit(phone, projectId) {
  setLatestProjectForPhone(phone, projectId);
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, formatQuickCopy("Project not found.", projectId));
  }

  await sendReply(phone, formatQuickCopy("Initializing Git repository...", projectId));
  const sourceDir = getSourceDir(projectId);
  await initAndCommit(sourceDir);

  await sendReply(phone, formatQuickCopy("Git repository initialized.", projectId));
}

async function handleGitPush(phone, projectId, repoName) {
  setLatestProjectForPhone(phone, projectId);
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, formatQuickCopy("Project not found.", projectId));
  }

  const token = getCredential("GITHUB_TOKEN");
  if (!token) {
    return await sendReply(phone, formatQuickCopy("GitHub push requires credentials.\n\nCRED GITHUB_TOKEN=your_token_here", projectId));
  }

  await sendReply(phone, formatQuickCopy(`Pushing to GitHub repo ${repoName}...`, projectId));

  const sourceDir = getSourceDir(projectId);
  const repoUrl = await createAndPush(sourceDir, repoName);
  updateMetadata(projectId, { githubUrl: repoUrl });

  await sendReply(phone, formatQuickCopy(`GitHub push succeeded.\n\nRepo: ${repoUrl}`, projectId));

  logger.info("GitHub repository created", { repo: repoName });
}

async function handleDownload(phone, projectId) {
  setLatestProjectForPhone(phone, projectId);
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, formatQuickCopy("Project not found.", projectId));
  }

  await sendReply(phone, formatQuickCopy("Creating project archive...", projectId));
  const archivePath = await archiveProject(projectId);
  const url = createDownloadToken(archivePath);
  await sendReply(phone, formatQuickCopy(`Archive ready.\n\nDownload: ${url}\nExpires in ${Math.round((env.DOWNLOAD_LINK_TTL_SECONDS || 3600) / 60)} minutes.`, projectId));
}

async function handleDeleteRepo(phone, repoName) {
  if (!repoName) {
    return await sendReply(phone, "Usage: *delete repo <repo-name>*");
  }

  const token = getCredential("GITHUB_TOKEN");
  if (!token) {
    return await sendReply(
      phone,
      `GitHub operations require a token.\n\nPlease send:\nCRED GITHUB_TOKEN=your_token_here`
    );
  }

  // Store pending confirmation (expires in 2 minutes)
  pendingDeletes.set(phone, {
    repoName,
    expiresAt: Date.now() + 2 * 60 * 1000,
  });

  await sendReply(
    phone,
    `You are about to delete repository *${repoName}*.\nThis action cannot be undone.\n\nReply with:\n*confirm delete ${repoName}*`
  );
}

async function handleConfirmDelete(phone, repoName) {
  const pending = pendingDeletes.get(phone);

  if (!pending || pending.repoName !== repoName) {
    return await sendReply(
      phone,
      `No pending deletion for *${repoName}*.\n\nFirst run: *delete repo ${repoName}*`
    );
  }

  if (Date.now() > pending.expiresAt) {
    pendingDeletes.delete(phone);
    return await sendReply(
      phone,
      `Deletion confirmation for *${repoName}* has expired.\n\nPlease run: *delete repo ${repoName}* again.`
    );
  }

  pendingDeletes.delete(phone);

  await sendReply(phone, `Deleting repository *${repoName}*...`);

  await deleteRepo(repoName);

  await sendReply(phone, `Repository *${repoName}* has been successfully deleted.`);
}

async function handleList(phone) {
  const projects = listProjects();
  if (!projects.length) {
    return await sendReply(phone, formatQuickCopy("No projects found.", getLatestProjectForPhone(phone)));
  }

  const lines = projects.map(
    (p) =>
      `- *${p.projectId}*\n  Status: ${p.status} | Created: ${new Date(p.createdAt).toLocaleDateString()}`
  );

  await sendReply(phone, formatQuickCopy(`Projects (${projects.length}):\n\n${lines.join("\n\n")}`, getLatestProjectForPhone(phone)));
}

async function handleStatus(phone, projectId) {
  setLatestProjectForPhone(phone, projectId);
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, formatQuickCopy("Project not found.", projectId));
  }

  const lines = [
    `*Project Status*`,
    ``,
    `*ID:* ${meta.projectId}`,
    `*Status:* ${meta.status}`,
    `*Created:* ${meta.createdAt}`,
    `*Expires:* ${meta.expiresAt}`,
  ];
  if (meta.deploymentUrl) lines.push(`*URL:* ${meta.deploymentUrl}`);
  if (meta.githubUrl) lines.push(`*GitHub:* ${meta.githubUrl}`);
  if (meta.framework) lines.push(`*Framework:* ${meta.framework}`);

  await sendReply(phone, formatQuickCopy(lines.join("\n"), projectId));
}

async function handleChat(phone, prompt) {
  await sendReply(phone, "Thinking...");
  const reply = await chatWithAI(prompt);
  await sendReply(phone, `${reply}\n\nModel: ${getModel()}`);
}

async function handleModify(phone, projectId, instruction) {
  setLatestProjectForPhone(phone, projectId);
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, formatQuickCopy("Project not found.", projectId));
  }

  const sourceDir = getSourceDir(projectId);
  if (!fs.existsSync(sourceDir)) {
    return await sendReply(phone, formatQuickCopy("Source directory missing.", projectId));
  }

  await sendReply(phone, formatQuickCopy("Analyzing project...", projectId));

  // Read existing project files
  const existingFiles = {};
  function readDirRecursive(dir, base) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) {
          if (["node_modules", ".git", ".next", "dist", "build", ".svelte-kit", ".cache"].includes(entry.name)) continue;
          readDirRecursive(full, rel);
        } else {
          if (["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"].includes(entry.name)) continue;
          try {
            existingFiles[rel.replace(/\\/g, "/")] = fs.readFileSync(full, "utf8");
          } catch { /* skip binary files */ }
        }
      }
    }
    readDirRecursive(sourceDir, "");

    await sendReply(phone, formatQuickCopy("Applying modifications...", projectId));

  // Send to AI for modification
  const project = await modifyProject(instruction, existingFiles);

  // Overwrite files
  writeFiles(sourceDir, project.files);

  await sendReply(phone, formatQuickCopy(`Files updated (${Object.keys(project.files).length} files). Rebuilding...`, projectId));

  // Rebuild
  const buildCmd = project.buildCommand || "npm install";
  const buildResult = await runInSandbox({
    command: buildCmd,
    workDir: sourceDir,
    envVars: buildEnvObject(["NODE_ENV"]),
  });

  if (buildResult.exitCode !== 0) {
    updateMetadata(projectId, { status: "build-failed" });
    return await sendReply(phone, formatQuickCopy(`Rebuild failed.\n\n${buildResult.stderr.slice(0, 500)}`, projectId));
  }

  updateMetadata(projectId, { status: "built", description: project.description || "" });

  // Attempt redeploy if Vercel token is available
  const token = getCredential("VERCEL_TOKEN");
  if (token) {
    await sendReply(phone, formatQuickCopy("Redeploying to Vercel...", projectId));
    const url = await deployToVercel(sourceDir);
    updateMetadata(projectId, { status: "deployed", deploymentUrl: url });
    await sendReply(phone, formatQuickCopy(`Modification complete.\n\nURL: ${url}`, projectId));
  } else {
    await sendReply(phone, formatQuickCopy("Modification and rebuild complete.", projectId));
  }

  logger.info("agent-controller: modify completed", { projectId, instruction: instruction.slice(0, 100) });
}

async function handleModels(phone) {
  const current = getModel();
  const modelList = [
    `*Available AI Models (8B-200B)*`,
    ``,
    `*OpenAI*`,
    `- openai/gpt-oss-120b -- 128K ctx`,
    `- openai/gpt-oss-20b -- 128K ctx`,
    ``,
    `*Qwen (Coders)*`,
    `- qwen/qwen3-coder-480b-a35b-instruct -- 262K ctx`,
    `- qwen/qwen3.5-122b-a10b -- 128K ctx`,
    `- qwen/qwen3-next-80b-a3b-instruct -- 128K ctx`,
    `- qwen/qwen2.5-coder-32b-instruct -- 32K ctx`,
    `- qwen/qwq-32b -- 32K ctx`,
    ``,
    `*DeepSeek*`,
    `- deepseek-ai/deepseek-v3.2 -- 128K ctx`,
    `- deepseek-ai/deepseek-v3.1 -- 128K ctx`,
    `- deepseek-ai/deepseek-r1-distill-qwen-32b -- 64K ctx`,
    `- deepseek-ai/deepseek-r1-distill-qwen-14b -- 64K ctx`,
    `- deepseek-ai/deepseek-r1-distill-llama-8b -- 64K ctx`,
    ``,
    `*Mistral (Coders)*`,
    `- mistralai/devstral-2-123b-instruct-2512 -- 128K ctx`,
    `- mistralai/mistral-large-2-instruct -- 128K ctx`,
    `- mistralai/mistral-medium-3-instruct -- 128K ctx`,
    `- mistralai/codestral-22b-instruct-v0.1 -- 32K ctx`,
    `- mistralai/mistral-small-3.1-24b-instruct-2503 -- 128K ctx`,
    `- mistralai/ministral-14b-instruct-2512 -- 128K ctx`,
    `- mistralai/mixtral-8x22b-instruct-v0.1 -- 64K ctx`,
    ``,
    `*Meta (Llama)*`,
    `- meta/llama-3.3-70b-instruct -- 128K ctx`,
    `- meta/llama-3.1-70b-instruct -- 128K ctx`,
    `- meta/llama-3.1-8b-instruct -- 128K ctx`,
    `- meta/codellama-70b -- 16K ctx`,
    `- meta/llama-3.2-90b-vision-instruct -- 128K ctx`,
    `- meta/llama-3.2-11b-vision-instruct -- 128K ctx`,
    ``,
    `*NVIDIA*`,
    `- nvidia/llama-3.3-nemotron-super-49b-v1.5 -- 128K ctx`,
    `- nvidia/llama-3.1-nemotron-70b-instruct -- 128K ctx`,
    `- nvidia/llama-3.1-nemotron-51b-instruct -- 128K ctx`,
    `- nvidia/usdcode-llama-3.1-70b-instruct -- 128K ctx`,
    `- nvidia/nemotron-3-super-120b-a12b -- 128K ctx`,
    `- nv-mistralai/mistral-nemo-12b-instruct -- 128K ctx`,
    ``,
    `*Microsoft*`,
    `- microsoft/phi-4-mini-instruct -- 128K ctx`,
    `- microsoft/phi-4-mini-flash-reasoning -- 128K ctx`,
    `- microsoft/phi-3-medium-128k-instruct -- 128K ctx`,
    `- microsoft/phi-3.5-moe-instruct -- 128K ctx`,
    ``,
    `*Google*`,
    `- google/gemma-3-27b-it -- 128K ctx`,
    `- google/gemma-3-12b-it -- 128K ctx`,
    `- google/gemma-2-27b-it -- 8K ctx`,
    ``,
    `*IBM (Code)*`,
    `- ibm/granite-34b-code-instruct -- 8K ctx`,
    `- ibm/granite-3.3-8b-instruct -- 128K ctx`,
    `- ibm/granite-8b-code-instruct -- 8K ctx`,
    ``,
    `*Other*`,
    `- moonshotai/kimi-k2-instruct -- 128K ctx`,
    `- bytedance/seed-oss-36b-instruct -- 32K ctx`,
    `- writer/palmyra-creative-122b -- 32K ctx`,
    `- abacusai/dracarys-llama-3.1-70b-instruct -- 128K ctx`,
    `- databricks/dbrx-instruct -- 32K ctx`,
    ``,
    `*Output tokens:* ${env.NVIDIA_MAX_TOKENS} (set via NVIDIA_MAX_TOKENS)`,
    `*Recommended:* openai/gpt-oss-120b`,
    `*Current model:* ${current}`,
    ``,
    `To switch: *model <name>*`,
    `Example: _model qwen/qwen3-coder-480b-a35b-instruct_`,
    ``,
    `---`,
    ``,
    `Model: ${current}`,
  ].join("\n");
  await sendReply(phone, formatQuickCopy(modelList, getLatestProjectForPhone(phone)));
}

async function handleUsage(phone) {
  const s = getUsageStats();
  const lines = [
    `*NVIDIA API Token Usage*`,
    `_(since last server restart: ${s.since})_`,
    ``,
    `Total requests: ${s.totalRequests}`,
    `Total tokens: ${s.totalTokens.toLocaleString()}`,
    `  Prompt tokens: ${s.totalPromptTokens.toLocaleString()}`,
    `  Completion tokens: ${s.totalCompletionTokens.toLocaleString()}`,
  ];

  const models = Object.entries(s.byModel);
  if (models.length > 0) {
    lines.push(``, `*Breakdown by model:*`);
    for (const [name, m] of models) {
      lines.push(`- ${name}`);
      lines.push(`  ${m.requests} req | ${(m.promptTokens + m.completionTokens).toLocaleString()} tokens`);
    }
  }

  lines.push(``, `_To check remaining API credits visit: https://build.nvidia.com_ (API Keys section)`);
  await sendReply(phone, formatQuickCopy(lines.join("\n"), getLatestProjectForPhone(phone)));
}

async function handleHelp(phone) {
  const helpText = `*ChatForge Commands*

*Build and Generate:*
- *build <description>* -- Generate and build an app
- *create <description>* -- Same as build
- *forge <description>* -- Generate, build, and deploy

*Deployment:*
- *debug <project-id>* -- Run diagnostic scan (deps, build, lint, typecheck)
- *fix <project-id>* -- Auto-fix common dependency/build issues
- *deploy <project-id>* -- Deploy to Vercel
- *connect <project-id>* -- Connect Vercel project to its GitHub repo
- *connect <project-id> <repo-name>* -- Connect to a specific repo

*Git and GitHub:*
- *init git <project-id>* -- Initialize Git repo
- *push <project-id> <repo-name>* -- Push to GitHub
- *delete repo <repo-name>* -- Delete a GitHub repository

*Projects:*
- *list* -- List all projects
- *status <project-id>* -- Check project status
- *download <project-id>* -- Create download archive

*AI Chat:*
- *chat <message>* -- Ask the AI any question
  Example: _chat explain microservices architecture_

*Modify and Chat:*
- *modify <project-id> <instruction>* -- Modify an existing project
  Example: _modify project-82ac1f add CSV export_
- *modify <instruction>* -- Uses latest project automatically

*Model:*
- *model <name>* -- Switch NVIDIA model
  Example: _model openai/gpt-oss-120b_
- *models* -- List available models
- *usage* -- Show token usage stats for this session

*Credentials:*
- *CRED KEY_NAME=value* -- Store a credential
  Required keys: VERCEL_TOKEN, GITHUB_TOKEN

*Example:*
_forge a Next.js portfolio site with dark mode_

Created by *Ruthvik Pitchika*`;

  await sendReply(phone, helpText);
}

/**
 * Full pipeline: generate → build → deploy.
 */
async function handleForge(phone, prompt) {
  const needs = detectExternalRequirements(prompt);
  if (needs.length > 0) {
    const missing = needs.filter((n) => n.creds.some((k) => !getCredential(k)));
    if (missing.length > 0) {
      const first = missing[0];
      const credExamples = first.creds.map((k) => `CRED ${k}=your_value`).join("\n");
      await sendReply(
        phone,
        formatQuickCopy(
          `External service required.\n\nThis project needs ${first.service}.\n\nRecommended options:\n${first.options.join("\n")}\n\nPlease provide credentials:\n${credExamples}\n\nGeneration will continue once credentials are provided.`,
          getLatestProjectForPhone(phone)
        )
      );
      return;
    }
  }

  await sendReply(phone, `**ChatForge Pipeline Started**\n\n  1. Generate code\n  2. Build project\n  3. Deploy to Vercel\n\nGenerating...`);

  // 1. Generate
  const project = await generateCode(prompt);
  const { projectId, sourceDir } = createProject();
  setLatestProjectForPhone(phone, projectId);
  writeFiles(sourceDir, project.files);

  await sendReply(phone, `Code generated (${Object.keys(project.files).length} files)\nBuilding...`);

  // 2. Build
  const buildCmd = project.buildCommand || "npm install";
  const buildResult = await runInSandbox({
    command: buildCmd,
    workDir: sourceDir,
    envVars: buildEnvObject(["NODE_ENV"]),
  });

  if (buildResult.exitCode !== 0) {
    updateMetadata(projectId, { status: "build-failed" });
    await sendReply(phone, `Build failed.\n\n${buildResult.stderr.slice(0, 500)}`);
    return;
  }

  updateMetadata(projectId, { status: "built" });
  await sendReply(phone, `Build succeeded\nDeploying...`);

  // 3. Deploy
  const token = getCredential("VERCEL_TOKEN");
  if (!token) {
    updateMetadata(projectId, { status: "built-awaiting-deploy" });
    await sendReply(phone, `Build complete for **${projectId}**\n\nTo deploy, send your Vercel token:\nCRED VERCEL_TOKEN=your_token\n\nThen: **deploy ${projectId}**`);
    return;
  }

  const url = await deployToVercel(sourceDir);
  updateMetadata(projectId, { status: "deployed", deploymentUrl: url });

  await sendReply(phone, `**Deployed!**\n\n${url}\n\nProject: **${projectId}**`);

  logger.info("agent-controller: forge pipeline completed", {
    projectId,
    url,
  });
}

async function handleDebug(phone, projectId) {
  setLatestProjectForPhone(phone, projectId);
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, formatQuickCopy("Project not found.", projectId));
  }

  const sourceDir = getSourceDir(projectId);
  const pkg = readPackageJson(sourceDir);
  if (!pkg) {
    return await sendReply(phone, formatQuickCopy("Debug failed: package.json not found.", projectId));
  }

  const scripts = pkg.scripts || {};
  const checks = [
    { name: "install", cmd: "npm install" },
    scripts.build ? { name: "build", cmd: "npm run build" } : null,
    scripts.lint ? { name: "lint", cmd: "npm run lint" } : null,
    scripts.typecheck ? { name: "typecheck", cmd: "npm run typecheck" } : null,
  ].filter(Boolean);

  const allIssues = [];
  const failingSteps = [];

  for (const step of checks) {
    const result = await runInSandbox({
      command: step.cmd,
      workDir: sourceDir,
      envVars: buildEnvObject(["NODE_ENV"]),
      timeout: 600_000,
    });
    const issues = buildDiagnosticIssues(`${result.stdout || ""}\n${result.stderr || ""}`);
    if (issues.length) allIssues.push(...issues);
    if (result.exitCode !== 0) {
      failingSteps.push(step.name);
    }
  }

  if (allIssues.length === 0 && failingSteps.length === 0) {
    updateMetadata(projectId, { status: "debug-clean" });
    return await sendReply(phone, formatQuickCopy("Debug scan complete. No critical issues found.", projectId));
  }

  const top = allIssues.slice(0, 10);
  const issueLines = top.map((i, idx) => {
    return [
      `${idx + 1}.`,
      `File: ${i.file}`,
      `Line: ${i.line}`,
      `Problem: ${i.problem}`,
      `Cause: ${i.cause}`,
      "",
    ].join("\n");
  });

  updateMetadata(projectId, {
    status: "debug-issues-found",
    lastDebugAt: new Date().toISOString(),
    lastDebugIssueCount: allIssues.length,
  });

  await sendReply(
    phone,
    formatQuickCopy(
      `Debug scan complete.\nFailing checks: ${failingSteps.join(", ") || "none"}\nIssues found: ${allIssues.length}\n\nAutomatically starting AI fix to solve these errors...`,
      projectId
    )
  );

  const existingFiles = {};
  function readDirRecursive(dir, base) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", ".next", "dist", "build", ".svelte-kit", ".cache"].includes(entry.name)) continue;
        readDirRecursive(full, rel);
      } else {
        if (["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"].includes(entry.name)) continue;
        try {
          existingFiles[rel.replace(/\\/g, "/")] = fs.readFileSync(full, "utf8");
        } catch { /* skip binary files */ }
      }
    }
  }
  readDirRecursive(sourceDir, "");

  const fixInstruction = `The build failed on steps: ${failingSteps.join(", ")}. Please fix the following errors:\n\n${issueLines.length > 0 ? issueLines.join("\n") : "Please review the code and fix compilation or linting errors."}`;
  const fixedProject = await modifyProject(fixInstruction, existingFiles);
  writeFiles(sourceDir, fixedProject.files);
  
  updateMetadata(projectId, { status: "debug-fixed" });
  await sendReply(
    phone,
    formatQuickCopy(`**Debug Complete**\n\nErrors have been automatically solved.\nThe project is finished and ready to build!`, projectId)
  );
}

async function handleFix(phone, projectId) {
  setLatestProjectForPhone(phone, projectId);
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, formatQuickCopy("Project not found.", projectId));
  }

  const sourceDir = getSourceDir(projectId);
  const pkg = readPackageJson(sourceDir);
  if (!pkg) {
    return await sendReply(phone, formatQuickCopy("Fix failed: package.json not found.", projectId));
  }

  await sendReply(phone, formatQuickCopy("Auto-fix started. Analyzing build errors...", projectId));

  const buildResult = await runInSandbox({
    command: "npm install && npm run build",
    workDir: sourceDir,
    envVars: buildEnvObject(["NODE_ENV"]),
    timeout: 600_000,
  });

  if (buildResult.exitCode === 0) {
    updateMetadata(projectId, { status: "built" });
    return await sendReply(phone, formatQuickCopy("No fixes required. Build already passes.", projectId));
  }

  const issues = buildDiagnosticIssues(`${buildResult.stdout || ""}\n${buildResult.stderr || ""}`);
  const missingDeps = new Set();
  for (const issue of issues) {
    const m = issue.problem.match(/Missing package:\s*([^\s]+)/i);
    if (m) missingDeps.add(m[1]);
  }

  if (missingDeps.size > 0) {
    const deps = Array.from(missingDeps);
    await runInSandbox({
      command: `npm install ${deps.join(" ")}`,
      workDir: sourceDir,
      envVars: buildEnvObject(["NODE_ENV"]),
      timeout: 600_000,
    });
  }

  const rebuild = await runInSandbox({
    command: "npm run build",
    workDir: sourceDir,
    envVars: buildEnvObject(["NODE_ENV"]),
    timeout: 600_000,
  });

  if (rebuild.exitCode === 0) {
    updateMetadata(projectId, {
      status: "built",
      lastFixAt: new Date().toISOString(),
      lastFixSummary: `Installed dependencies: ${Array.from(missingDeps).join(", ") || "none"}`,
    });
    return await sendReply(
      phone,
      formatQuickCopy(
        `Auto-fix complete. Build now passes.\n\nInstalled dependencies: ${Array.from(missingDeps).join(", ") || "none"}`,
        projectId
      )
    );
  }

  updateMetadata(projectId, {
    status: "build-failed",
    lastFixAt: new Date().toISOString(),
  });

  await sendReply(
    phone,
    formatQuickCopy(`Auto-fix incomplete.\n\n${(rebuild.stderr || rebuild.stdout || "Unknown error").slice(0, 700)}`, projectId)
  );
}
