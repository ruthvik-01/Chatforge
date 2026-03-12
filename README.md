<div align="center">

```
  ██████╗██╗  ██╗ █████╗ ████████╗███████╗ ██████╗ ██████╗  ██████╗ ███████╗
 ██╔════╝██║  ██║██╔══██╗╚══██╔══╝██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝
 ██║     ███████║███████║   ██║   █████╗  ██║   ██║██████╔╝██║  ███╗█████╗
 ██║     ██╔══██║██╔══██║   ██║   ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝
 ╚██████╗██║  ██║██║  ██║   ██║   ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗
  ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝
```

**Build, deploy, and manage full-stack apps — entirely from WhatsApp.**

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Sandboxed-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![NVIDIA AI](https://img.shields.io/badge/NVIDIA-AI%20API-76B900?style=flat-square&logo=nvidia&logoColor=white)](https://build.nvidia.com/)
[![Vercel](https://img.shields.io/badge/Deploys%20to-Vercel-000000?style=flat-square&logo=vercel&logoColor=white)](https://vercel.com/)
[![Azure](https://img.shields.io/badge/Hosted%20on-Azure-0078D4?style=flat-square&logo=microsoft-azure&logoColor=white)](https://azure.microsoft.com/)

</div>

---

ChatForge is a **WhatsApp-controlled AI developer server**. Send a plain-English message and it will generate, build, version-control, and deploy a full-stack application — no local tooling required.

---

## Architecture

```
┌──────────────┐     HTTPS      ┌────────────────────────────────────┐
│   WhatsApp   │ ──────────────▶│  Azure VM – ChatForge Server       │
│   (User)     │ ◀────────────  │                                    │
└──────────────┘                │  ┌──────────────┐                  │
                                │  │ Webhook Server│ (Express)       │
                                │  └──────┬───────┘                  │
                                │         │                          │
                                │  ┌──────▼───────┐                  │
                                │  │ Agent Control │ (OpenClaw)      │
                                │  └──────┬───────┘                  │
                                │         │                          │
                                │  ┌──────▼───────┐  ┌────────────┐ │
                                │  │ NVIDIA AI API │  │ Credential │ │
                                │  │   Client      │  │  Manager   │ │
                                │  └──────┬───────┘  └────────────┘ │
                                │         │                          │
                                │  ┌──────▼───────┐                  │
                                │  │  Workspace    │                  │
                                │  │  Manager      │                  │
                                │  └──────┬───────┘                  │
                                │         │                          │
                                │  ┌──────▼───────┐                  │
                                │  │ Docker Sandbox│ (Build)         │
                                │  └──────┬───────┘                  │
                                │         │                          │
                                │  ┌──────▼───────┐  ┌────────────┐ │
                                │  │ Vercel Deploy │  │ Git Manager│ │
                                │  └──────────────┘  └────────────┘ │
                                └────────────────────────────────────┘
```

## Prerequisites

- **Azure VM**: Ubuntu 22.04+ with Docker installed
- **Node.js**: v20+
- **Docker**: Engine 24+ (for sandbox builds)
- **Meta Developer Account**: WhatsApp Cloud API access
- **NVIDIA AI API Key**: From [NVIDIA AI](https://build.nvidia.com/)
- **Vercel Account**: For deployments
- **Domain + SSL**: For HTTPS webhook endpoint (use nginx + Let's Encrypt)

---

## Quick Start

### 1. Clone & Configure

```bash
git clone <your-repo-url> /opt/chatforge
cd /opt/chatforge
cp .env.example .env
```

Edit `.env` with your actual values (see **Environment Configuration** below).

### 2. Generate Encryption Key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the output into `ENCRYPTION_KEY` in `.env`.

### 3. Install Dependencies

```bash
npm ci --omit=dev
```

### 4. Pull Sandbox Image

```bash
docker pull node:20-slim
```

### 5. Start the Server

**Direct:**

```bash
node index.js
```

**Via Docker Compose (recommended for production):**

```bash
docker compose up -d
```

---

## Environment Configuration

| Variable                   | Required | Description                                       |
| -------------------------- | -------- | ------------------------------------------------- |
| `PORT`                     | No       | Server port (default: 3000)                       |
| `WHATSAPP_VERIFY_TOKEN`    | **Yes**  | Token for webhook verification                    |
| `WHATSAPP_API_TOKEN`       | **Yes**  | WhatsApp Cloud API access token                   |
| `WHATSAPP_PHONE_NUMBER_ID` | **Yes**  | Your WhatsApp business phone number ID            |
| `WHATSAPP_APP_SECRET`      | **Yes**  | App secret for signature verification             |
| `OWNER_PHONE_NUMBER`       | **Yes**  | Authorized phone number (no `+` prefix)           |
| `NVIDIA_API_KEY`           | **Yes**  | NVIDIA AI API key                                 |
| `ENCRYPTION_KEY`           | **Yes**  | 64-char hex string for AES-256-GCM                |
| `DOCKER_SANDBOX_IMAGE`     | No       | Docker image for builds (default: `node:20-slim`) |
| `DOCKER_CPU_LIMIT`         | No       | CPU limit for sandbox (default: 1)                |
| `DOCKER_MEMORY_LIMIT`      | No       | Memory limit (default: `512m`)                    |
| `PROJECT_RETENTION_DAYS`   | No       | Days before project auto-deletion (default: 7)    |
| `CREDENTIAL_TTL_SECONDS`   | No       | Credential expiry in seconds (default: 3600)      |

---

## WhatsApp Cloud API Setup

### 1. Create a Meta Developer App

1. Go to [Meta for Developers](https://developers.facebook.com/)
2. Create a new app → Select **Business** type
3. Add the **WhatsApp** product

### 2. Configure the Webhook

1. In your app dashboard, go to **WhatsApp → Configuration**
2. Set the **Callback URL** to: `https://your-domain.com/webhook`
3. Set the **Verify Token** to match your `WHATSAPP_VERIFY_TOKEN` env var
4. Subscribe to the **messages** field

### 3. Get API Credentials

From the WhatsApp section of your app dashboard, collect:

- **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
- **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`
- **Temporary Access Token** (or generate a permanent System User Token) → `WHATSAPP_API_TOKEN`
- **App Secret** (from App Settings → Basic) → `WHATSAPP_APP_SECRET`

### 4. Test Number

Use the provided test phone number to send messages. Add your personal phone number as a recipient in the **API Setup** tab.

---

## NVIDIA AI API Setup

1. Visit [NVIDIA AI](https://build.nvidia.com/)
2. Create an account and generate an API key
3. Set `NVIDIA_API_KEY` in your `.env`
4. The default model is `meta/llama-3.1-405b-instruct` – change via `NVIDIA_MODEL`

---

## WhatsApp Commands

| Command                         | Description                                 |
| ------------------------------- | ------------------------------------------- |
| `help`                          | Show all available commands                 |
| `build <description>`           | Generate & build an application             |
| `create <description>`          | Same as build                               |
| `forge <description>`           | Generate, build, AND deploy (full pipeline) |
| `deploy <project-id>`           | Deploy existing project to Vercel           |
| `init git <project-id>`         | Initialize Git repository                   |
| `push <project-id> <repo-name>` | Push to GitHub                              |
| `list`                          | List all projects                           |
| `status <project-id>`           | Show project details                        |
| `download <project-id>`         | Create downloadable archive                 |
| `CRED KEY=value`                | Store an encrypted credential               |

### Examples

```
forge a React dashboard with charts and dark mode
```

```
build a Next.js blog with Markdown support
```

```
CRED VERCEL_TOKEN=abc123xyz
deploy 550e8400-e29b-41d4-a716-446655440000
```

```
CRED GITHUB_TOKEN=ghp_xxxxxxxxxxxx
push 550e8400-e29b-41d4-a716-446655440000 my-blog
```

---

## Secure Credential Handling

Credentials are collected via WhatsApp and handled securely:

1. **Encrypted at rest** – AES-256-GCM encryption with unique IV per credential
2. **Auto-expire** – Credentials automatically expire after `CREDENTIAL_TTL_SECONDS`
3. **Masked in logs** – All log output runs through a secret-masking filter
4. **File permissions** – Encrypted files are stored with `0600` permissions
5. **Periodic sweep** – Expired credentials are automatically cleaned up

### Providing Credentials

When a deployment needs a token, the bot will ask for it:

```
🔑 Deployment requires a Vercel token.

Please send:
CRED VERCEL_TOKEN=your_token_here
```

Reply with:

```
CRED VERCEL_TOKEN=ver_xxxxxxxxxxxxxxxx
```

### Optional: Azure Key Vault

For production environments, configure Azure Key Vault:

```env
AZURE_KEY_VAULT_URL=https://your-vault.vault.azure.net/
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-client-id
AZURE_CLIENT_SECRET=your-client-secret
```

---

## Azure VM Setup

### 1. Create the VM

```bash
az vm create \
  --resource-group chatforge-rg \
  --name chatforge-vm \
  --image Ubuntu2204 \
  --size Standard_B2s \
  --admin-username azureuser \
  --generate-ssh-keys
```

### 2. Configure Network Security Group

```bash
# Allow SSH
az vm open-port --port 22 --resource-group chatforge-rg --name chatforge-vm --priority 1000

# Allow HTTPS (webhook endpoint)
az vm open-port --port 443 --resource-group chatforge-rg --name chatforge-vm --priority 1010

# Deny all other inbound traffic (default)
```

### 3. Install Prerequisites on the VM

```bash
ssh azureuser@<vm-ip>

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install nginx for reverse proxy
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

### 4. Configure Nginx Reverse Proxy

```nginx
# /etc/nginx/sites-available/chatforge
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Enable site and get SSL cert
sudo ln -s /etc/nginx/sites-available/chatforge /etc/nginx/sites-enabled/
sudo certbot --nginx -d your-domain.com
sudo systemctl restart nginx
```

### 5. Deploy ChatForge

```bash
cd /opt/chatforge
cp .env.example .env
# Edit .env with real values
nano .env

# Start with Docker Compose
docker compose up -d

# Check logs
docker compose logs -f chatforge
```

---

## Security Architecture

### Defense in Depth

| Layer              | Protection                                                      |
| ------------------ | --------------------------------------------------------------- |
| **Network**        | Azure NSG: only ports 22 + 443 open                             |
| **TLS**            | nginx + Let's Encrypt for HTTPS                                 |
| **Authentication** | WhatsApp webhook signature verification (HMAC-SHA256)           |
| **Authorization**  | Owner phone number whitelist                                    |
| **Rate Limiting**  | 60 requests/minute per IP                                       |
| **Sandbox**        | Docker containers with CPU/memory limits, dropped capabilities  |
| **Command Safety** | Regex blocklist for dangerous commands (rm -rf, shutdown, etc.) |
| **Encryption**     | AES-256-GCM for all stored secrets                              |
| **Logging**        | Secret masking in all log output                                |
| **Path Traversal** | All file operations validated against workspace root            |
| **Credential TTL** | Auto-expiring secrets with periodic sweep                       |

### Blocked Commands

The system blocks these patterns from executing in the sandbox:

- `rm -rf /` and variants
- `shutdown`, `reboot`
- `mkfs`, `dd if=`
- Fork bombs
- Writing to `/dev/sd*`
- `chmod 777 /`
- Pipe-to-shell (`curl | sh`, `wget | sh`)

---

## Project Structure

```
ChatForge/
├── index.js                    # Entry point
├── package.json
├── Dockerfile                  # Server container
├── Dockerfile.sandbox          # Build sandbox image
├── docker-compose.yml
├── .env.example
├── .gitignore
│
├── config/
│   ├── env-loader.js           # Environment validation & loading
│   ├── encryption.js           # AES-256-GCM encrypt/decrypt
│   └── security.js             # Signature verification, command safety
│
├── server/
│   ├── webhook-server.js       # Express + WhatsApp webhook
│   ├── agent-controller.js     # Command routing & AI orchestration
│   ├── nvidia-client.js        # NVIDIA AI API integration
│   ├── credential-manager.js   # Encrypted credential storage
│   ├── workspace-manager.js    # Project lifecycle management
│   ├── docker-runner.js        # Sandboxed Docker execution
│   ├── git-manager.js          # Git init, commit, GitHub push
│   ├── deploy-vercel.js        # Vercel CLI deployment
│   └── logger.js               # Winston structured logging
│
├── workspace/                  # Generated projects (gitignored)
├── secrets/                    # Encrypted credentials (gitignored)
└── logs/                       # Application logs (gitignored)
```

---

## Deployment Workflow

The full **forge** pipeline:

```
User sends: "forge a React todo app"
  │
  ├─ 1. Webhook receives & verifies message
  ├─ 2. Agent controller parses command
  ├─ 3. NVIDIA AI generates project code (JSON response)
  ├─ 4. Workspace manager creates project directory
  ├─ 5. Files written to /workspace/<project-id>/source/
  ├─ 6. Docker sandbox runs: npm install && npm run build
  ├─ 7. If VERCEL_TOKEN available:
  │     └─ Vercel CLI deploys from sandbox
  │     └─ Deployment URL captured
  ├─ 8. Metadata updated with status & URL
  └─ 9. Reply sent to WhatsApp with deployment URL
```

---

## Monitoring

### Health Check

```bash
curl https://your-domain.com/health
```

### Logs

```bash
# Real-time logs
docker compose logs -f chatforge

# Log files
ls -la /logs/
cat /logs/combined.log | jq .
cat /logs/error.log | jq .
```

### Docker Compose Commands

```bash
docker compose up -d       # Start
docker compose down        # Stop
docker compose restart     # Restart
docker compose logs -f     # Stream logs
docker compose ps          # Status
```

---

## License

MIT
#   C h a t f o r g e  
 