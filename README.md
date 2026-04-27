# smtp-mcp-server

An MCP (Model Context Protocol) server for sending emails via SMTP — designed to run as a Docker container behind Traefik with optional Authelia OIDC authentication.

## Tools

| Tool | Description |
|------|-------------|
| `send_email` | Send an email with subject, plain text and/or HTML body, optional CC/BCC/Reply-To |
| `verify_smtp_connection` | Check that the SMTP server is reachable and credentials are valid |

### `send_email` parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `to` | ✓ | Recipient(s), comma-separated |
| `subject` | ✓ | Email subject |
| `body` | ✓ | Plain text body |
| `html` | — | HTML body (optional, supplements plain text) |
| `cc` | — | CC recipients, comma-separated |
| `bcc` | — | BCC recipients, comma-separated |
| `reply_to` | — | Reply-To address |
| `from_name` | — | Sender display name (e.g. `"John Doe"`) |

## Setup

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false        # true for port 465 (SSL), false for STARTTLS
SMTP_USER=user@example.com
SMTP_PASS=your-password
SMTP_FROM=user@example.com

MCP_API_KEY=your-secret-api-key

# Optional: Authelia OIDC (for Claude.ai OAuth)
OIDC_CLIENT_ID=smtp-mcp-client
OIDC_CLIENT_SECRET=your-oidc-secret
```

### 2. Adjust Traefik hostname

In `docker-compose.yml`, replace `smtp-mcp.yourdomain.com` with your actual domain.

### 3. Start

```bash
docker compose up -d --build
```

## Authentication

The server supports two auth mechanisms — they are checked in order:

1. **Static Bearer token** (Claude Desktop / API clients)
   Set `MCP_API_KEY` and pass it as `Authorization: Bearer <key>`.

2. **JWT via Authelia OIDC introspection** (Claude.ai)
   Claude.ai obtains a JWT from Authelia via OAuth authorization code flow. The server validates it by calling Authelia's `/api/oidc/introspection` endpoint.
   Requires `OIDC_INTROSPECTION_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` to be set.

If `MCP_API_KEY` is not set, all requests are accepted without authentication.

## Connecting to Claude.ai

In Claude.ai → Settings → Connectors → Add custom connector:

| Field | Value |
|-------|-------|
| Name | SMTP Email |
| Remote MCP Server URL | `https://smtp-mcp.yourdomain.com/mcp` |
| OAuth Client ID | your `OIDC_CLIENT_ID` |
| OAuth Client Secret | your `OIDC_CLIENT_SECRET` |

> **Note:** Authelia must have an OAuth client registered for Claude.ai with the redirect URI `https://claude.ai/api/mcp/auth_callback`.

## Connecting to Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "smtp-email": {
      "command": "node",
      "args": ["/path/to/smtp-mcp-server/build/index.js"],
      "env": {
        "SMTP_HOST": "smtp.example.com",
        "SMTP_PORT": "587",
        "SMTP_USER": "user@example.com",
        "SMTP_PASS": "your-password",
        "SMTP_FROM": "user@example.com"
      }
    }
  }
}
```

Or via HTTP (if running in Docker):

```json
{
  "mcpServers": {
    "smtp-email": {
      "type": "http",
      "url": "https://smtp-mcp.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-api-key"
      }
    }
  }
}
```

## Development

```bash
npm install
npm run build       # compile TypeScript
npm run inspect     # launch MCP inspector
```

## Architecture

```
Claude.ai / Claude Desktop
        │
        │ HTTPS (Bearer JWT or static token)
        ▼
   Traefik (reverse proxy + TLS)
        │
        ▼
smtp-mcp-server :3000
        │
        │ STARTTLS / SSL
        ▼
   SMTP Server
```

Endpoints exposed by the server:

| Endpoint | Protocol | Description |
|----------|----------|-------------|
| `POST /mcp` | Streamable HTTP | Primary MCP endpoint (Claude.ai) |
| `GET /sse` | Server-Sent Events | Legacy SSE transport |
| `POST /messages` | HTTP | SSE message handler |

## License

ISC
