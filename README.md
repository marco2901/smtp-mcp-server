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

Edit `.env` with your values (see `.env.example` for all options):

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=user@example.com
SMTP_PASS=your-password
SMTP_FROM=user@example.com

MCP_DOMAIN=smtp-mcp.yourdomain.com

MCP_API_KEY=your-secret-api-key

OIDC_CLIENT_ID=smtp-mcp
OIDC_CLIENT_SECRET=your-oidc-secret
```

### 2. Start

```bash
docker compose up -d
```

The image is pulled automatically from GHCR (`ghcr.io/marco2901/smtp-mcp-server:latest`). No local build needed.

## Authentication

The server supports two auth mechanisms — checked in order:

1. **Static Bearer token** (Claude Desktop / direct API clients)
   Set `MCP_API_KEY` and pass it as `Authorization: Bearer <key>`.

2. **JWT via Authelia OIDC introspection** (Claude.ai)
   Claude.ai obtains a JWT from Authelia via OAuth authorization code flow. The server validates it against Authelia's `/api/oidc/introspection` endpoint.
   Requires `OIDC_INTROSPECTION_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`.

If `MCP_API_KEY` is not set, all requests are accepted without authentication.

## Connecting to Claude.ai

In Claude.ai → Settings → Connectors → Add custom connector:

| Field | Value |
|-------|-------|
| Name | SMTP Email |
| Remote MCP Server URL | `https://<MCP_DOMAIN>/sse` |
| OAuth Client ID | your `OIDC_CLIENT_ID` |
| OAuth Client Secret | your `OIDC_CLIENT_SECRET` |

> **Note:** Your Authelia instance must have an OAuth client registered with redirect URI `https://claude.ai/api/mcp/auth_callback`.

## Connecting to Claude Desktop

Via HTTP (Docker):

```json
{
  "mcpServers": {
    "smtp-email": {
      "type": "http",
      "url": "https://<MCP_DOMAIN>/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-api-key"
      }
    }
  }
}
```

Via stdio (local):

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
| `POST /mcp` | Streamable HTTP | Primary MCP endpoint |
| `GET /sse` | Server-Sent Events | SSE transport (Claude.ai) |
| `POST /messages` | HTTP | SSE message handler |

## License

ISC
