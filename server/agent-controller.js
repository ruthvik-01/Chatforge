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
let sendReply = async () => {};
export function setSendReply(fn) {
  sendReply = fn;
}

// Pending deletion confirmations: Map<phone, { repoName, expiresAt }>
const pendingDeletes = new Map();

// ──── Per-project concurrency locks ────
// Prevents two mutating operations (build, deploy, modify, push, connect) from
// running on the same project simultaneously. Non-project commands (chat, list,
// help, status, models) are never blocked.
const projectLocks = new Map();

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
    if (lower.startsWith("deploy ")) {
      const projectId = text.replace(/^deploy\s+/i, "").trim();
      return await withProjectLock(userPhone, projectId, "deploy", () =>
        handleDeploy(userPhone, projectId)
      );
    }

    // ── Git init ──
    if (lower.startsWith("init git ")) {
      const projectId = text.replace(/^init git\s+/i, "").trim();
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
    if (lower.startsWith("download ")) {
      const projectId = text.replace(/^download\s+/i, "").trim();
      return await handleDownload(userPhone, projectId);
    }

    // ── List projects ──
    if (lower === "list" || lower === "projects") {
      return await handleList(userPhone);
    }

    // ── Status ──
    if (lower.startsWith("status ")) {
      const projectId = text.replace(/^status\s+/i, "").trim();
      return await handleStatus(userPhone, projectId);
    }

    // ── AI Chat ──
    if (lower.startsWith("chat ")) {
      const userPrompt = text.replace(/^chat\s+/i, "");
      return await handleChat(userPhone, userPrompt);
    }

    // ── Modify existing project ──
    if (lower.startsWith("modify ")) {
      const rest = text.replace(/^modify\s+/i, "").trim();
      const spaceIdx = rest.indexOf(" ");
      if (spaceIdx === -1) {
        return await sendReply(userPhone, "Usage: *modify <project-id> <instruction>*");
      }
      const projectId = rest.slice(0, spaceIdx).trim();
      const instruction = rest.slice(spaceIdx + 1).trim();
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
        return await sendReply(userPhone, `Current model: *${getModel()}*`);
      }
      setModel(newModel);
      logger.info("agent-controller: model switched", { model: newModel });
      return await sendReply(userPhone, `Model switched to *${newModel}*`);
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
    await sendReply(
      userPhone,
      `Unknown command. Send *help* for available commands.`
    );
  } catch (err) {
    logger.error("agent-controller: command error", {
      error: err.message,
      stack: err.stack,
    });
    await sendReply(
      userPhone,
      `Error: ${err.message}\n\nSend *help* for assistance.`
    );
  }
}

// ──────────── Command Handlers ────────────

async function handleCredential(phone, text) {
  const { parseAndStoreCredential } = await import("./credential-manager.js");
  const key = parseAndStoreCredential(text);
  if (key) {
    await sendReply(phone, `Credential *${key}* stored securely (encrypted, expires in TTL).`);
  } else {
    await sendReply(phone, `Invalid format. Use: CRED KEY_NAME=value`);
  }
}

async function handleBuild(phone, prompt) {
  await sendReply(phone, `Starting build...\n\n*Prompt:* ${prompt.slice(0, 200)}...\n\nGenerating code with AI...`);

  // 1. Generate code
  const project = await generateCode(prompt);

  // 2. Create workspace
  const { projectId, sourceDir } = createProject();
  writeFiles(sourceDir, project.files);

  await sendReply(
    phone,
    `Project *${projectId}* created.\n${Object.keys(project.files).length} files generated.\nRunning build...`
  );

  // 3. Build in sandbox
  const buildCmd = project.buildCommand || "npm install";
  const result = await runInSandbox({
    command: buildCmd,
    workDir: sourceDir,
    envVars: buildEnvObject(["NODE_ENV"]),
  });

  if (result.exitCode !== 0) {
    updateMetadata(projectId, { status: "build-failed" });
    await sendReply(
      phone,
      `Build failed for *${projectId}*.\n\n${result.stderr.slice(0, 500)}`
    );
    return;
  }

  updateMetadata(projectId, {
    status: "built",
    framework: project.framework || "unknown",
    description: project.description || "",
  });

  await sendReply(
    phone,
    `Build succeeded for *${projectId}*\n\nCommands:\n- *deploy ${projectId}* -- deploy to Vercel\n- *init git ${projectId}* -- initialize Git repo\n- *modify ${projectId} <instruction>* -- modify the project\n- *status ${projectId}* -- check status\n\n---\nModel: ${getModel()}`
  );

  logger.info("agent-controller: build completed", { projectId });
}

async function handleDeploy(phone, projectId) {
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, `Project *${projectId}* not found.`);
  }

  // Check for Vercel token
  const token = getCredential("VERCEL_TOKEN");
  if (!token) {
    return await sendReply(
      phone,
      `Deployment requires a Vercel token.\n\nPlease send:\nCRED VERCEL_TOKEN=your_token_here\n\nThen retry: deploy ${projectId}`
    );
  }

  await sendReply(phone, `Deploying *${projectId}* to Vercel...`);

  const sourceDir = getSourceDir(projectId);
  const url = await deployToVercel(sourceDir);
  updateMetadata(projectId, { status: "deployed", deploymentUrl: url });

  await sendReply(phone, `Deployed!\n\n*${url}*\n\nProject: *${projectId}*`);

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
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, `Project *${projectId}* not found.`);
  }

  await sendReply(phone, `Initializing Git repo for *${projectId}*...`);
  const sourceDir = getSourceDir(projectId);
  await initAndCommit(sourceDir);

  await sendReply(
    phone,
    `Git repo initialized for *${projectId}*.\n\nTo push to GitHub: *push ${projectId} repo-name*`
  );
}

async function handleGitPush(phone, projectId, repoName) {
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, `Project *${projectId}* not found.`);
  }

  const token = getCredential("GITHUB_TOKEN");
  if (!token) {
    return await sendReply(
      phone,
      `GitHub push requires a token.\n\nPlease send:\nCRED GITHUB_TOKEN=your_token_here\n\nThen retry: push ${projectId} ${repoName}`
    );
  }

  await sendReply(phone, `Pushing *${projectId}* to GitHub as *${repoName}*...`);

  const sourceDir = getSourceDir(projectId);
  const repoUrl = await createAndPush(sourceDir, repoName);
  updateMetadata(projectId, { githubUrl: repoUrl });

  await sendReply(phone, `Pushed to GitHub!\n\n${repoUrl}`);

  logger.info("GitHub repository created", { repo: repoName });
}

async function handleDownload(phone, projectId) {
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, `Project *${projectId}* not found.`);
  }

  await sendReply(phone, `Creating archive for *${projectId}*...`);
  const archivePath = await archiveProject(projectId);
  const url = createDownloadToken(archivePath);
  await sendReply(
    phone,
    `Archive ready for *${projectId}*.\n\nDownload: ${url}\n\n_Link expires in ${Math.round((env.DOWNLOAD_LINK_TTL_SECONDS || 3600) / 60)} minutes and is single-use._`
  );
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
    return await sendReply(phone, "No projects found.");
  }

  const lines = projects.map(
    (p) =>
      `- *${p.projectId}*\n  Status: ${p.status} | Created: ${new Date(p.createdAt).toLocaleDateString()}`
  );

  await sendReply(phone, `*Projects (${projects.length}):*\n\n${lines.join("\n\n")}`);
}

async function handleStatus(phone, projectId) {
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, `Project *${projectId}* not found.`);
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

  await sendReply(phone, lines.join("\n"));
}

async function handleChat(phone, prompt) {
  await sendReply(phone, "Thinking...");
  const reply = await chatWithAI(prompt);
  await sendReply(phone, `${reply}\n\n---\nModel: ${getModel()}`);
}

async function handleModify(phone, projectId, instruction) {
  const meta = getMetadata(projectId);
  if (!meta) {
    return await sendReply(phone, `Project *${projectId}* not found.`);
  }

  const sourceDir = getSourceDir(projectId);
  if (!fs.existsSync(sourceDir)) {
    return await sendReply(phone, `Source directory missing for *${projectId}*.`);
  }

  await sendReply(phone, `Analyzing project *${projectId}*...`);

  // Read existing project files
  const existingFiles = {};
  function readDirRecursive(dir, base) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        readDirRecursive(full, rel);
      } else {
        try {
          existingFiles[rel.replace(/\\/g, "/")] = fs.readFileSync(full, "utf8");
        } catch { /* skip binary files */ }
      }
    }
  }
  readDirRecursive(sourceDir, "");

  await sendReply(phone, `Applying modifications...`);

  // Send to AI for modification
  const project = await modifyProject(instruction, existingFiles);

  // Overwrite files
  writeFiles(sourceDir, project.files);

  await sendReply(phone, `Files updated (${Object.keys(project.files).length} files).\nRebuilding...`);

  // Rebuild
  const buildCmd = project.buildCommand || "npm install";
  const buildResult = await runInSandbox({
    command: buildCmd,
    workDir: sourceDir,
    envVars: buildEnvObject(["NODE_ENV"]),
  });

  if (buildResult.exitCode !== 0) {
    updateMetadata(projectId, { status: "build-failed" });
    return await sendReply(
      phone,
      `Rebuild failed for *${projectId}*.\n\n${buildResult.stderr.slice(0, 500)}\n\n---\nModel: ${getModel()}`
    );
  }

  updateMetadata(projectId, { status: "built", description: project.description || "" });

  // Attempt redeploy if Vercel token is available
  const token = getCredential("VERCEL_TOKEN");
  if (token) {
    await sendReply(phone, `Redeploying *${projectId}* to Vercel...`);
    const url = await deployToVercel(sourceDir);
    updateMetadata(projectId, { status: "deployed", deploymentUrl: url });
    await sendReply(
      phone,
      `*Modification complete!*\n\n*${url}*\nProject: *${projectId}*\n\n---\nModel: ${getModel()}`
    );
  } else {
    await sendReply(
      phone,
      `*Modification and rebuild complete.*\n\nProject: *${projectId}*\n\nTo deploy: *deploy ${projectId}*\n\n---\nModel: ${getModel()}`
    );
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
  await sendReply(phone, modelList);
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
  await sendReply(phone, lines.join("\n"));
}

async function handleHelp(phone) {
  const helpText = `*ChatForge Commands*

*Build and Generate:*
- *build <description>* -- Generate and build an app
- *create <description>* -- Same as build
- *forge <description>* -- Generate, build, and deploy

*Deployment:*
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

*Modify:*
- *modify <project-id> <instruction>* -- Modify an existing project
  Example: _modify project-82ac1f add CSV export_

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
  await sendReply(
    phone,
    `*ChatForge Pipeline Started*\n\n1. Generate code\n2. Build project\n3. Deploy to Vercel\n\nGenerating...`
  );

  // 1. Generate
  const project = await generateCode(prompt);
  const { projectId, sourceDir } = createProject();
  writeFiles(sourceDir, project.files);

  await sendReply(
    phone,
    `Code generated (${Object.keys(project.files).length} files)\nBuilding...`
  );

  // 2. Build
  const buildCmd = project.buildCommand || "npm install";
  const buildResult = await runInSandbox({
    command: buildCmd,
    workDir: sourceDir,
    envVars: buildEnvObject(["NODE_ENV"]),
  });

  if (buildResult.exitCode !== 0) {
    updateMetadata(projectId, { status: "build-failed" });
    await sendReply(
      phone,
      `Build failed.\n\n${buildResult.stderr.slice(0, 500)}\n\nProject ID: *${projectId}*`
    );
    return;
  }

  updateMetadata(projectId, { status: "built" });
  await sendReply(phone, `Build succeeded\nDeploying...`);

  // 3. Deploy
  const token = getCredential("VERCEL_TOKEN");
  if (!token) {
    updateMetadata(projectId, { status: "built-awaiting-deploy" });
    await sendReply(
      phone,
      `Build complete for *${projectId}*\n\nTo deploy, send your Vercel token:\nCRED VERCEL_TOKEN=your_token\n\nThen: *deploy ${projectId}*`
    );
    return;
  }

  const url = await deployToVercel(sourceDir);
  updateMetadata(projectId, { status: "deployed", deploymentUrl: url });

  await sendReply(
    phone,
    `*ChatForge Pipeline Complete*\n\n*${url}*\nProject: *${projectId}*\nFiles: ${Object.keys(project.files).length}\n\nCommands:\n- *status ${projectId}*\n- *init git ${projectId}*\n- *modify ${projectId} <instruction>*\n\n---\nModel: ${getModel()}`
  );

  logger.info("agent-controller: forge pipeline completed", {
    projectId,
    url,
  });
}
