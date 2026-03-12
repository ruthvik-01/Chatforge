// server/workspace-manager.js – Project workspace lifecycle management
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import archiver from "archiver";
import env from "../config/env-loader.js";
import logger from "./logger.js";

const WORKSPACE = env.WORKSPACE_DIR;

// Ensure workspace root exists
if (!fs.existsSync(WORKSPACE)) {
  fs.mkdirSync(WORKSPACE, { recursive: true });
}

/**
 * Create a new project workspace.
 * @returns {{ projectId: string, projectDir: string, sourceDir: string, buildDir: string }}
 */
export function createProject() {
  const projectId = uuidv4();
  const projectDir = path.join(WORKSPACE, projectId);
  const sourceDir = path.join(projectDir, "source");
  const buildDir = path.join(projectDir, "build");

  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });

  const metadata = {
    projectId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(
      Date.now() + env.PROJECT_RETENTION_DAYS * 86400 * 1000
    ).toISOString(),
    deploymentUrl: null,
    status: "created",
  };

  fs.writeFileSync(
    path.join(projectDir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
    "utf8"
  );

  logger.info(`workspace-manager: created project ${projectId}`);
  return { projectId, projectDir, sourceDir, buildDir };
}

/**
 * Write AI-generated files into the project source directory.
 * @param {string} sourceDir
 * @param {Record<string, string>} files  Mapping of relative paths → content.
 */
export function writeFiles(sourceDir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    // Prevent path traversal
    const resolved = path.resolve(sourceDir, relPath);
    if (!resolved.startsWith(path.resolve(sourceDir))) {
      logger.warn(
        `workspace-manager: blocked path traversal attempt: ${relPath}`
      );
      continue;
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
  }
  logger.info(
    `workspace-manager: wrote ${Object.keys(files).length} files into ${sourceDir}`
  );
}

/**
 * Read project metadata.
 * @param {string} projectId
 * @returns {object|null}
 */
export function getMetadata(projectId) {
  const sanitizedId = projectId.replace(/[^a-zA-Z0-9-]/g, "");
  const metaPath = path.join(WORKSPACE, sanitizedId, "metadata.json");
  if (!fs.existsSync(metaPath)) return null;
  return JSON.parse(fs.readFileSync(metaPath, "utf8"));
}

/**
 * Update project metadata fields.
 * @param {string} projectId
 * @param {object} updates
 */
export function updateMetadata(projectId, updates) {
  const sanitizedId = projectId.replace(/[^a-zA-Z0-9-]/g, "");
  const metaPath = path.join(WORKSPACE, sanitizedId, "metadata.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  Object.assign(meta, updates);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
}

/**
 * Get the source directory for a project.
 * @param {string} projectId
 * @returns {string}
 */
export function getSourceDir(projectId) {
  const sanitizedId = projectId.replace(/[^a-zA-Z0-9-]/g, "");
  return path.join(WORKSPACE, sanitizedId, "source");
}

/**
 * Get the project root directory.
 * @param {string} projectId
 * @returns {string}
 */
export function getProjectDir(projectId) {
  const sanitizedId = projectId.replace(/[^a-zA-Z0-9-]/g, "");
  return path.join(WORKSPACE, sanitizedId);
}

/**
 * Create a ZIP archive of a project.
 * @param {string} projectId
 * @returns {Promise<string>}  Path to the archive file.
 */
export function archiveProject(projectId) {
  return new Promise((resolve, reject) => {
    const sanitizedId = projectId.replace(/[^a-zA-Z0-9-]/g, "");
    const projectDir = path.join(WORKSPACE, sanitizedId);
    if (!fs.existsSync(projectDir)) {
      return reject(new Error(`Project ${sanitizedId} not found.`));
    }

    const archivePath = path.join(WORKSPACE, `${sanitizedId}.zip`);
    const output = fs.createWriteStream(archivePath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      logger.info(
        `workspace-manager: archived project ${sanitizedId} (${archive.pointer()} bytes)`
      );
      resolve(archivePath);
    });

    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(projectDir, sanitizedId);
    archive.finalize();
  });
}

/**
 * List all projects.
 * @returns {object[]}
 */
export function listProjects() {
  if (!fs.existsSync(WORKSPACE)) return [];
  return fs
    .readdirSync(WORKSPACE, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== ".gitkeep")
    .map((d) => getMetadata(d.name))
    .filter(Boolean);
}

/**
 * Delete expired projects.
 */
export function sweepExpiredProjects() {
  const projects = listProjects();
  for (const meta of projects) {
    if (new Date(meta.expiresAt) < new Date()) {
      const dir = path.join(WORKSPACE, meta.projectId);
      fs.rmSync(dir, { recursive: true, force: true });
      // Also remove any zip
      const zip = path.join(WORKSPACE, `${meta.projectId}.zip`);
      if (fs.existsSync(zip)) fs.unlinkSync(zip);
      logger.info(
        `workspace-manager: deleted expired project ${meta.projectId}`
      );
    }
  }
}
