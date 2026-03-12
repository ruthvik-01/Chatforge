// server/docker-runner.js – Sandboxed Docker container execution
import Docker from "dockerode";
import { isCommandBlocked } from "../config/security.js";
import env from "../config/env-loader.js";
import logger from "./logger.js";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

/**
 * Parse Docker memory limit string (e.g. "512m") into bytes.
 */
function parseMemoryLimit(limit) {
  const match = limit.match(/^(\d+)([kmg]?)b?$/i);
  if (!match) return 512 * 1024 * 1024;
  const num = parseInt(match[1], 10);
  const unit = (match[2] || "m").toLowerCase();
  const multipliers = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return num * (multipliers[unit] || 1024 ** 2);
}

/**
 * Run a command inside a Docker sandbox container.
 *
 * @param {object} options
 * @param {string} options.command       Shell command to run inside the container.
 * @param {string} options.workDir       Host directory to mount as /app in the container.
 * @param {object} [options.envVars={}]  Environment variables to inject.
 * @param {number} [options.timeout=300000]  Timeout in ms (default 5 min).
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export async function runInSandbox({ command, workDir, envVars = {}, timeout = 300_000 }) {
  // Command safety check
  if (isCommandBlocked(command)) {
    const msg = `docker-runner: BLOCKED dangerous command: ${command}`;
    logger.error(msg);
    throw new Error(msg);
  }

  logger.info("docker-runner: starting sandbox", { command, workDir });

  const envArr = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);

  const memoryBytes = parseMemoryLimit(env.DOCKER_MEMORY_LIMIT);
  const nanoCpus = env.DOCKER_CPU_LIMIT * 1e9;

  const container = await docker.createContainer({
    Image: env.DOCKER_SANDBOX_IMAGE,
    Cmd: ["/bin/sh", "-c", command],
    WorkingDir: "/app",
    Env: envArr,
    HostConfig: {
      Binds: [`${workDir}:/app`],
      Memory: memoryBytes,
      NanoCpus: nanoCpus,
      AutoRemove: true,
      NetworkMode: env.DOCKER_NETWORK_DISABLED ? "none" : "bridge",
      ReadonlyRootfs: false,
      // Drop all capabilities except what's needed to install packages
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "SETGID", "SETUID", "DAC_OVERRIDE"],
      SecurityOpt: ["no-new-privileges"],
    },
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const timeoutHandle = setTimeout(async () => {
    timedOut = true;
    try {
      await container.stop({ t: 5 });
    } catch {
      try { await container.kill(); } catch { /* already stopped */ }
    }
  }, timeout);

  try {
    const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });

    // Demux stdout/stderr
    const { PassThrough } = await import("stream");
    const outStream = new PassThrough();
    const errStream = new PassThrough();

    outStream.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    errStream.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    docker.modem.demuxStream(stream, outStream, errStream);

    await container.start();
    const result = await container.wait();
    clearTimeout(timeoutHandle);

    // Allow streams to flush
    await new Promise((r) => setTimeout(r, 500));

    if (timedOut) {
      throw new Error(
        `docker-runner: container timed out after ${timeout}ms`
      );
    }

    const exitCode = result.StatusCode;
    logger.info("docker-runner: container finished", {
      exitCode,
      stdoutLen: stdout.length,
      stderrLen: stderr.length,
    });

    return { exitCode, stdout, stderr };
  } catch (err) {
    clearTimeout(timeoutHandle);
    // Make sure container is cleaned up on error
    try {
      await container.stop({ t: 2 });
    } catch { /* ignore */ }
    try {
      await container.remove({ force: true });
    } catch { /* already removed via AutoRemove */ }
    throw err;
  }
}

/**
 * Pull the sandbox image if not already present.
 */
export async function ensureSandboxImage() {
  const imageName = env.DOCKER_SANDBOX_IMAGE;
  try {
    await docker.getImage(imageName).inspect();
    logger.info(`docker-runner: image ${imageName} already present`);
  } catch {
    logger.info(`docker-runner: pulling image ${imageName}...`);
    await new Promise((resolve, reject) => {
      docker.pull(imageName, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2) =>
          err2 ? reject(err2) : resolve()
        );
      });
    });
    logger.info(`docker-runner: image ${imageName} pulled successfully`);
  }
}
