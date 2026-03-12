# ── ChatForge Server Dockerfile ──────────────────────────────────────────
FROM node:20-slim

# Install Docker CLI (for Docker-in-Docker via mounted socket) and Git
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | \
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
    > /etc/apt/sources.list.d/docker.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

# Create app user (non-root)
RUN groupadd -r chatforge && useradd -r -g chatforge -m chatforge

# Create working directories
RUN mkdir -p /app /workspace /logs /secrets && \
    chown -R chatforge:chatforge /app /workspace /logs /secrets

WORKDIR /app

# Copy package files and install deps
COPY --chown=chatforge:chatforge package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy application code
COPY --chown=chatforge:chatforge . .

# Switch to non-root user
USER chatforge

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "index.js"]
