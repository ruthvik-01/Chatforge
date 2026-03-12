<h1 align="center">ChatForge</h1>

<p align="center">
  <strong>Build, deploy, and manage full-stack apps — entirely from WhatsApp.</strong>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="License: MIT"></a>
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/Docker-Sandboxed-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker"></a>
  <a href="https://build.nvidia.com/"><img src="https://img.shields.io/badge/NVIDIA-AI%20API-76B900?style=flat-square&logo=nvidia&logoColor=white" alt="NVIDIA AI"></a>
  <a href="https://vercel.com/"><img src="https://img.shields.io/badge/Deploys%20to-Vercel-000000?style=flat-square&logo=vercel&logoColor=white" alt="Vercel"></a>
  <a href="https://azure.microsoft.com/"><img src="https://img.shields.io/badge/Hosted%20on-Azure-0078D4?style=flat-square&logo=microsoft-azure&logoColor=white" alt="Azure"></a>
</p>

---

ChatForge is a **WhatsApp-controlled AI developer server**. Send a plain-English message and it will generate, build, version-control, and deploy a full-stack application — no local tooling required.

---

## How It Works

```
 You (WhatsApp)          Azure VM – ChatForge
 ───────────────         ──────────────────────────────────────────────────
  "forge a React    ──▶  Webhook Server  (Express + HMAC-SHA256 verify)
   todo app"             │
                         ▼
                         Agent Controller  (command router + concurrency locks)
                         │
                   ┌─────┴──────────────────────────┐
                   ▼                                 ▼
            NVIDIA AI Client                  Credential Manager
            (code generation)                 (AES-256-GCM store)
                   │
                   ▼
            Workspace Manager  (/workspace/<id>/)
                   │
                   ▼
            Docker Sandbox     (npm install && npm run build)
                   │
            ┌──────┴──────────┐
            ▼                 ▼
       Vercel Deploy      Git Manager
       (live URL)         (GitHub push)
                   │
                   ▼
 "✅ Deployed →   ◀──  WhatsApp reply
  https://…"
```

---

## Features

|                             |                                                                          |
| --------------------------- | ------------------------------------------------------------------------ |
| **Natural language builds** | Describe any web app in plain English; ChatForge writes every file       |
| **One-step forge pipeline** | Generate → build → deploy in a single WhatsApp message                   |
| **Docker sandboxed builds** | Each build runs in an isolated container with dropped Linux capabilities |
| **Encrypted credentials**   | Vercel & GitHub tokens stored with AES-256-GCM, auto-expire after 1 hour |
| **Per-project locks**       | Prevents concurrent mutations on the same project                        |
| **NVIDIA AI models**        | Switch between models at runtime (`model <name>`)                        |
| **GitHub integration**      | Push to a new GitHub repo with a single command                          |
| **Vercel deployment**       | One-command deploy via the Vercel CLI inside the sandbox                 |
| **Project lifecycle**       | List, inspect, modify, download, or delete any project                   |
| **Auto-cleanup**            | Expired projects and credentials swept every hour                        |

---

## Tech Stack

| Layer             | Technology                                      |
| ----------------- | ----------------------------------------------- |
| Runtime           | Node.js 20+ (ESM)                               |
| HTTP server       | Express 4 + Helmet + express-rate-limit         |
| AI backend        | NVIDIA AI API (llama-3.1-405b default)          |
| Containerization  | Docker / Dockerode                              |
| Deployment target | Vercel CLI                                      |
| Version control   | GitHub via REST API                             |
| Encryption        | Node.js `crypto` — AES-256-GCM                  |
| Logging           | Winston (structured JSON)                       |
| Hosting           | Azure VM (Ubuntu 22.04) + nginx + Let's Encrypt |

---

## Prerequisites

- **Azure VM** — Ubuntu 22.04+, Docker Engine 24+
- **Node.js** — v20 or newer
- **Meta Developer Account** — WhatsApp Cloud API access
- **NVIDIA AI API key** — from [build.nvidia.com](https://build.nvidia.com/)
- **Vercel account** — for deployments
- **Domain + SSL** — HTTPS endpoint for the webhook (nginx + Let's Encrypt)

---

## Quick Start

### 1. Clone & configure

```bash
git clone <your-repo-url> /opt/chatforge
cd /opt/chatforge
cp .env.example .env
nano .env   # fill in all required values
```

### 2. Generate an encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Paste the output into ENCRYPTION_KEY in .env
```

### 3. Install dependencies

```bash
npm ci --omit=dev
```

### 4. Start

```bash
# Development
node --watch index.js

# Production (recommended)
docker compose up -d
```

---

## Environment Variables

### Required

| Variable                   | Description                                       |
| -------------------------- | ------------------------------------------------- |
| `WHATSAPP_VERIFY_TOKEN`    | Webhook verification token                        |
| `WHATSAPP_API_TOKEN`       | WhatsApp Cloud API access token                   |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp business phone number ID                 |
| `WHATSAPP_APP_SECRET`      | App secret for HMAC-SHA256 signature verification |
| `OWNER_PHONE_NUMBER`       | Authorized phone number (no `+` prefix)           |
| `NVIDIA_API_KEY`           | NVIDIA AI API key                                 |
| `ENCRYPTION_KEY`           | 64-char hex string for AES-256-GCM                |

### Optional

| Variable                 | Default                        | Description                          |
| ------------------------ | ------------------------------ | ------------------------------------ |
| `PORT`                   | `3000`                         | HTTP server port                     |
| `NVIDIA_MODEL`           | `meta/llama-3.1-405b-instruct` | Default AI model                     |
| `DOCKER_SANDBOX_IMAGE`   | `node:20-slim`                 | Container image for builds           |
| `DOCKER_CPU_LIMIT`       | `1`                            | CPU quota per sandbox                |
| `DOCKER_MEMORY_LIMIT`    | `512m`                         | Memory cap per sandbox               |
| `PROJECT_RETENTION_DAYS` | `7`                            | Days before auto-deletion            |
| `CREDENTIAL_TTL_SECONDS` | `3600`                         | Credential expiry (seconds)          |
| `AZURE_KEY_VAULT_URL`    | —                              | Optional Azure Key Vault integration |

---

## WhatsApp Setup

### 1. Create a Meta Developer App

1. Go to [developers.facebook.com](https://developers.facebook.com/)
2. Create a new **Business** app and add the **WhatsApp** product.

### 2. Configure the webhook

1. Navigate to **WhatsApp → Configuration**
2. Set **Callback URL** → `https://your-domain.com/webhook`
3. Set **Verify Token** → value of `WHATSAPP_VERIFY_TOKEN`
4. Subscribe to the **messages** field

### 3. Collect credentials

| Dashboard field | Env variable               |
| --------------- | -------------------------- |
| Phone Number ID | `WHATSAPP_PHONE_NUMBER_ID` |
| Access Token    | `WHATSAPP_API_TOKEN`       |
| App Secret      | `WHATSAPP_APP_SECRET`      |

---

## NVIDIA AI Setup

1. Visit [build.nvidia.com](https://build.nvidia.com/) and generate an API key.
2. Set `NVIDIA_API_KEY` in `.env`.
3. Optionally override the model with `NVIDIA_MODEL` (or change it live with the `model` command).

---

## Command Reference

### Build & Deploy

| Command                             | Description                                      |
| ----------------------------------- | ------------------------------------------------ |
| `build <description>`               | Generate & build an app from a description       |
| `create <description>`              | Alias for `build`                                |
| `forge <description>`               | Full pipeline: generate → build → deploy         |
| `deploy <project-id>`               | Deploy an existing project to Vercel             |
| `modify <project-id> <instruction>` | Modify an existing project with new instructions |

### Version Control

| Command                         | Description                                        |
| ------------------------------- | -------------------------------------------------- |
| `init git <project-id>`         | Initialise a Git repository                        |
| `push <project-id> <repo-name>` | Create a GitHub repo and push                      |
| `delete repo <repo-name>`       | Delete a GitHub repository (requires confirmation) |

### Project Management

| Command                 | Description                               |
| ----------------------- | ----------------------------------------- |
| `list`                  | List all projects                         |
| `status <project-id>`   | Show build/deploy status                  |
| `download <project-id>` | Package project as a downloadable archive |

### AI & Credentials

| Command          | Description                       |
| ---------------- | --------------------------------- |
| `chat <message>` | Ask the AI assistant a question   |
| `model <name>`   | Switch the active NVIDIA AI model |
| `models`         | List available models             |
| `CRED KEY=value` | Store an encrypted credential     |
| `help`           | Show all commands                 |

### Example workflows

```
# One-shot full deployment
forge a React dashboard with dark mode and real-time charts

# Build first, deploy later
build a Next.js blog with Markdown support
CRED VERCEL_TOKEN=ver_xxxxxxxxxxxx
deploy 550e8400

# Push to GitHub
CRED GITHUB_TOKEN=ghp_xxxxxxxxxxxx
push 550e8400 my-blog-repo

# Modify after the fact
modify 550e8400 add a contact form with email validation
```

---

## Credentials & Security

### Providing credentials

When a deployment needs a token the bot will prompt you:

```
Deployment requires a Vercel token.
Please send:  CRED VERCEL_TOKEN=your_token_here
```

Reply with:

```
CRED VERCEL_TOKEN=ver_xxxxxxxxxxxxxxxx
```

### Credential storage guarantees

1. **Encrypted at rest** — AES-256-GCM with a unique IV per credential
2. **Auto-expire** — automatically deleted after `CREDENTIAL_TTL_SECONDS`
3. **Masked in logs** — all Winston output is filtered before writing
4. **`0600` permissions** — credential files unreadable by other OS users
5. **Periodic sweep** — expired entries cleaned up every hour

### Defense in depth

| Layer          | Protection                                                             |
| -------------- | ---------------------------------------------------------------------- |
| Network        | Azure NSG — only ports 22 + 443 open                                   |
| TLS            | nginx + Let's Encrypt                                                  |
| Authentication | HMAC-SHA256 webhook signature verification                             |
| Authorization  | Single-owner phone number whitelist                                    |
| Rate limiting  | 60 requests / minute per IP                                            |
| Sandbox        | Docker — dropped capabilities, CPU/memory limits                       |
| Command safety | Regex blocklist (`rm -rf /`, `shutdown`, fork bombs, pipe-to-shell, …) |
| Encryption     | AES-256-GCM for all stored secrets                                     |
| Path traversal | All file ops validated against workspace root                          |

---

## Azure VM Setup

```bash
# 1. Create the VM
az vm create \
  --resource-group chatforge-rg \
  --name chatforge-vm \
  --image Ubuntu2204 \
  --size Standard_B2s \
  --admin-username azureuser \
  --generate-ssh-keys

# 2. Open only the ports you need
az vm open-port --port 22  --resource-group chatforge-rg --name chatforge-vm --priority 1000
az vm open-port --port 443 --resource-group chatforge-rg --name chatforge-vm --priority 1010

# 3. SSH in and install dependencies
ssh azureuser@<vm-ip>
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

### Nginx reverse proxy

```nginx
# /etc/nginx/sites-available/chatforge
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass             http://127.0.0.1:3000;
        proxy_http_version     1.1;
        proxy_set_header Host  $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/chatforge /etc/nginx/sites-enabled/
sudo certbot --nginx -d your-domain.com
sudo systemctl restart nginx
```

---

## Project Structure

```
ChatForge/
├── index.js                     # Entry point — startup & cleanup scheduler
├── package.json
├── Dockerfile                   # Production server image
├── Dockerfile.sandbox           # Build sandbox image
├── docker-compose.yml
├── .env.example
│
├── config/
│   ├── env-loader.js            # Env validation & frozen config object
│   ├── encryption.js            # AES-256-GCM helpers
│   └── security.js              # Webhook signature + command blocklist
│
├── server/
│   ├── webhook-server.js        # Express app + WhatsApp message sender
│   ├── agent-controller.js      # Command router + per-project locks
│   ├── nvidia-client.js         # NVIDIA AI API client
│   ├── credential-manager.js    # Encrypted credential store with TTL
│   ├── workspace-manager.js     # Project lifecycle & metadata
│   ├── docker-runner.js         # Sandboxed container execution
│   ├── git-manager.js           # Git init, commit, GitHub push/delete
│   ├── deploy-vercel.js         # Vercel CLI deployment wrapper
│   └── logger.js                # Winston logger with secret masking
│
├── workspace/                   # Generated projects  (gitignored)
├── secrets/                     # Encrypted credentials (gitignored)
└── logs/                        # Application logs     (gitignored)
```

---

## Monitoring

```bash
# Health endpoint
curl https://your-domain.com/health

# Live container logs
docker compose logs -f chatforge

# Structured log files
cat /logs/combined.log | jq .
cat /logs/error.log    | jq .

# Container management
docker compose up -d        # start
docker compose down         # stop
docker compose restart      # restart
docker compose ps           # status
```

---

## License

[MIT](LICENSE)
