# smtp-mcp-server

An MCP (Model Context Protocol) server for **reading (IMAP)** and **sending (SMTP)** emails — designed to run as a Docker container behind Traefik with optional Authelia OIDC authentication. Works with any IMAP/SMTP mailbox (IONOS, T-Online, etc.); run one instance per mailbox.

## Tools

**Reading (IMAP)** — enabled when `IMAP_*` is configured:

| Tool | Description |
|------|-------------|
| `list_emails` | List the most recent emails in a mailbox (default INBOX), optionally unread-only |
| `read_email` | Read the full content of a message by UID (headers, body, attachment list) |
| `search_emails` | Search by sender, recipient, subject, body, date range, or unread state |
| `list_folders` | List all available mailboxes/folders |
| `mark_as_read` / `mark_as_unread` | Toggle a message's read state by UID |
| `verify_imap_connection` | Check that the IMAP server is reachable and credentials are valid |

**Sending (SMTP)** — enabled when `SMTP_*` is configured:

| Tool | Description |
|------|-------------|
| `send_email` | Send an email with subject, plain text and/or HTML body, optional CC/BCC/Reply-To |
| `verify_smtp_connection` | Check that the SMTP server is reachable and credentials are valid |

At least one of SMTP / IMAP must be configured. UIDs returned by `list_emails`/`search_emails` are stable per mailbox — pass them to `read_email`/`mark_as_read`.

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
# Sending (SMTP)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=user@example.com
SMTP_PASS=your-password
SMTP_FROM=user@example.com

# Reading (IMAP) — falls IMAP_USER/PASS leer, werden SMTP_USER/PASS genutzt
IMAP_HOST=imap.example.com
IMAP_PORT=993
IMAP_SECURE=true
IMAP_USER=user@example.com
IMAP_PASS=your-password

MCP_DOMAIN=mail-mcp.yourdomain.com

MCP_API_KEY=your-secret-api-key

OIDC_CLIENT_ID=mail-mcp
OIDC_CLIENT_SECRET=your-oidc-secret
```

Provider quick-reference:

| Provider | SMTP | IMAP |
|----------|------|------|
| IONOS | `smtp.ionos.de:587` (STARTTLS, `SMTP_SECURE=false`) | `imap.ionos.de:993` (SSL) |
| T-Online | `securesmtp.t-online.de:465` (SSL, `SMTP_SECURE=true`) | `secureimap.t-online.de:993` (SSL) — requires a „Passwort für E-Mail-Programme" |

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

### Authelia OIDC client

Add to your Authelia `configuration.yml` under `identity_providers.oidc.clients`:

```yaml
- client_id: smtp-mcp
  client_name: SMTP MCP Server
  client_secret: '$pbkdf2-sha512$310000$...'   # pbkdf2-sha512 hash
  public: false
  authorization_policy: one_factor
  redirect_uris:
    - https://claude.ai/api/mcp/auth_callback
  scopes: [openid, profile, email, offline_access]
  grant_types: [authorization_code, refresh_token]
  response_types: [code]
  token_endpoint_auth_method: client_secret_post
  introspection_endpoint_auth_method: client_secret_basic
```

> **Authelia 4.39+:** OIDC client secrets must be **pbkdf2** or **argon2id** — bcrypt
> (`$2b$…`/`$2y$…`) is deprecated and returns *„client secret did not match"*
> at the token endpoint. Generate a hash with:
> ```bash
> docker run --rm authelia/authelia:latest \
>   authelia crypto hash generate pbkdf2 --variant sha512 \
>   --password '<plain-OIDC_CLIENT_SECRET>'
> ```
> Use the `Digest:` value as `client_secret` in `configuration.yml`. The
> plaintext goes into `OIDC_CLIENT_SECRET` in the stack. Restart Authelia.

> **`OIDC_INTROSPECTION_URL` must be the external HTTPS URL** (e.g.
> `https://authelia.example.com/api/oidc/introspection`). Authelia 4.39+
> validates `X-Forwarded-Proto` against the token issuer and rejects calls
> from internal `http://authelia:9091/...` with *„invalid X-Forwarded-Proto
> header value 'http'"*.

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
 SMTP (send) + IMAP (read) — same mailbox
```

Endpoints exposed by the server:

| Endpoint | Protocol | Description |
|----------|----------|-------------|
| `POST /mcp` | Streamable HTTP | Primary MCP endpoint |
| `GET /sse` | Server-Sent Events | SSE transport (Claude.ai) |
| `POST /messages` | HTTP | SSE message handler |

## License

ISC
