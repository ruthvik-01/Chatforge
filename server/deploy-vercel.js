// server/deploy-vercel.js – Vercel CLI deployment
import { runInSandbox } from "./docker-runner.js";
import { getCredential } from "./credential-manager.js";
import logger from "./logger.js";
import env from "../config/env-loader.js";
import fs from "fs";
import path from "path";
import axios from "axios";

/**
 * Common output directories by framework.
 */
const OUTPUT_DIR_CANDIDATES = [
  "dist",        // Vite, Rollup, Parcel
  ".next",       // Next.js
  "build",       // Create React App
  "out",         // Next.js static export
  ".output",     // Nuxt 3
  "public",      // Hugo, some static generators
];

/**
 * Detect the output directory and ensure vercel.json exists before deploying.
 */
function ensureVercelConfig(sourceDir) {
  const vercelConfigPath = path.join(sourceDir, "vercel.json");

  // If vercel.json already exists, leave it alone
  if (fs.existsSync(vercelConfigPath)) {
    logger.info("deploy-vercel: existing vercel.json found");
    return;
  }

  // Check package.json for framework hints
  let framework = null;
  let buildScript = null;
  const pkgPath = path.join(sourceDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps["next"]) framework = "nextjs";
      else if (allDeps["vite"] || allDeps["@vitejs/plugin-react"]) framework = "vite";
      else if (allDeps["react-scripts"]) framework = "cra";
      else if (allDeps["nuxt"]) framework = "nuxt";
      else if (allDeps["vue"]) framework = "vue";
      buildScript = pkg.scripts?.build;
    } catch { /* ignore parse errors */ }
  }

  // Determine the correct output directory
  let outputDir = null;

  // Check if any known output dirs already exist (from a previous build)
  for (const candidate of OUTPUT_DIR_CANDIDATES) {
    if (fs.existsSync(path.join(sourceDir, candidate))) {
      outputDir = candidate;
      break;
    }
  }

  // If nothing found yet, infer from framework
  if (!outputDir) {
    if (framework === "nextjs") outputDir = ".next";
    else if (framework === "cra") outputDir = "build";
    else if (framework === "nuxt") outputDir = ".output";
    else outputDir = "dist"; // default for Vite and most modern bundlers
  }

  // Write vercel.json
  const config = { outputDirectory: outputDir };

  // For non-Next.js SPA frameworks, add a rewrite rule for client-side routing
  if (framework !== "nextjs" && framework !== "nuxt") {
    config.rewrites = [{ source: "/(.*)", destination: "/index.html" }];
  }

  fs.writeFileSync(vercelConfigPath, JSON.stringify(config, null, 2), "utf8");
  logger.info("deploy-vercel: generated vercel.json", { outputDir, framework });
}

/**
 * Deploy a project to Vercel using the CLI inside a sandbox container.
 * @param {string} sourceDir  Absolute path to the project source directory.
 * @returns {Promise<string>}  The deployment URL.
 */
export async function deployToVercel(sourceDir) {
  const token = getCredential("VERCEL_TOKEN") || env.VERCEL_TOKEN;
  if (!token) {
    throw new Error(
      "VERCEL_TOKEN is required for deployment. Send: CRED VERCEL_TOKEN=your_token"
    );
  }

  logger.info("deploy-vercel: starting deployment", { sourceDir });

  // Ensure vercel.json exists with correct output directory
  ensureVercelConfig(sourceDir);

  // Install Vercel CLI and deploy in one shot
  const command = [
    "npm install -g vercel@latest 2>/dev/null",
    "vercel --prod --yes --token $VERCEL_TOKEN 2>&1",
  ].join(" && ");

  const result = await runInSandbox({
    command,
    workDir: sourceDir,
    envVars: { VERCEL_TOKEN: token },
    timeout: 600_000, // 10 minutes for deployment
  });

  // Combine stdout + stderr for full output analysis
  const fullOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");

  if (result.exitCode !== 0) {
    // Extract the meaningful Vercel error, not npm deprecation warnings
    const errorMsg = extractVercelError(fullOutput);
    logger.error("deploy-vercel: deployment failed", {
      stderr: result.stderr,
      stdout: result.stdout,
      extractedError: errorMsg,
    });
    throw new Error(`Vercel deployment failed: ${errorMsg}`);
  }

  // Extract the deployment URL from stdout
  const url = extractDeploymentUrl(result.stdout);
  if (!url) {
    logger.warn("deploy-vercel: could not extract URL from output", {
      stdout: result.stdout,
    });
    throw new Error(
      "Deployment may have succeeded but URL could not be extracted."
    );
  }

  logger.info("deploy-vercel: deployed successfully", { url });
  return url;
}

/**
 * Connect a Vercel project to a GitHub repository for automatic deployments.
 * @param {string} deploymentUrl  The Vercel deployment URL (e.g. https://my-app.vercel.app)
 * @param {string} githubOwner    GitHub username
 * @param {string} githubRepo     GitHub repository name
 * @returns {Promise<object>}     Result with connection status
 */
export async function connectVercelToGitHub(deploymentUrl, githubOwner, githubRepo) {
  const token = getCredential("VERCEL_TOKEN") || env.VERCEL_TOKEN;
  if (!token) {
    throw new Error("VERCEL_TOKEN is required. Send: CRED VERCEL_TOKEN=your_token");
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // Extract the Vercel project name from the deployment URL
  // e.g. https://my-project-abc123.vercel.app -> my-project-abc123
  const projectName = deploymentUrl
    .replace(/^https?:\/\//, "")
    .replace(/\.vercel\.app.*$/, "");

  logger.info("deploy-vercel: connecting to GitHub", { projectName, githubOwner, githubRepo });

  // Step 1: Get the Vercel project to confirm it exists
  let project;
  try {
    const res = await axios.get(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}`,
      { headers, timeout: 15_000 }
    );
    project = res.data;
  } catch (err) {
    if (err.response?.status === 404) {
      throw new Error(`Vercel project "${projectName}" not found. Deploy the project first.`);
    }
    throw new Error(`Failed to fetch Vercel project: ${err.response?.data?.error?.message || err.message}`);
  }

  // Step 2: Link the project to the GitHub repo
  try {
    const res = await axios.patch(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(project.id)}`,
      {
        gitRepository: {
          type: "github",
          repo: `${githubOwner}/${githubRepo}`,
        },
      },
      { headers, timeout: 15_000 }
    );

    logger.info("deploy-vercel: connected to GitHub", {
      projectId: project.id,
      repo: `${githubOwner}/${githubRepo}`,
    });

    return {
      vercelProject: project.name,
      vercelProjectId: project.id,
      githubRepo: `${githubOwner}/${githubRepo}`,
      dashboardUrl: `https://vercel.com/${res.data?.accountId ? res.data.accountId + "/" : ""}${project.name}/settings/git`,
    };
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    // Common case: GitHub integration not installed on Vercel
    if (errMsg.includes("integration") || errMsg.includes("git") || err.response?.status === 400) {
      throw new Error(
        `Could not connect: ${errMsg}\n\nMake sure the Vercel GitHub Integration is installed:\nhttps://vercel.com/integrations/github`
      );
    }
    throw new Error(`Failed to connect Vercel to GitHub: ${errMsg}`);
  }
}

/**
 * Extract a Vercel deployment URL from CLI output.
 * @param {string} output
 * @returns {string|null}
 */
function extractDeploymentUrl(output) {
  // Vercel CLI prints the production URL, usually like https://project-xxx.vercel.app
  const urlMatch = output.match(/https:\/\/[a-zA-Z0-9_-]+\.vercel\.app/);
  if (urlMatch) return urlMatch[0];

  // Also try generic https URL on its own line
  const lines = output.split("\n").map((l) => l.trim());
  for (const line of lines) {
    if (/^https:\/\//.test(line) && line.includes(".")) {
      return line;
    }
  }
  return null;
}

/**
 * Extract the actual Vercel error from combined output, filtering out npm warnings.
 * @param {string} output
 * @returns {string}
 */
function extractVercelError(output) {
  const lines = output.split("\n");

  // Look for Vercel-specific error lines
  const errorLines = lines.filter(
    (l) =>
      (l.includes("Error:") || l.includes("error:") || l.includes("ERR!")) &&
      !l.includes("npm warn") &&
      !l.includes("deprecated")
  );

  if (errorLines.length > 0) {
    return errorLines.join("\n").trim().slice(0, 500);
  }

  // Fall back to last meaningful lines (skip blank lines and npm warnings)
  const meaningful = lines.filter(
    (l) => l.trim() && !l.startsWith("npm warn") && !l.includes("deprecated")
  );
  return (meaningful.slice(-5).join("\n") || output).trim().slice(0, 500);
}
