#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { NextFunction, Request, Response } from "express";

import { parseArgs } from "node:util";
import { registerEmailTools } from "./tools/email";
import { registerImapTools } from "./tools/imap";
import { registerComposeTools } from "./tools/compose";
import { registerAttachmentTools, registerAttachmentRoute } from "./tools/attachments";
import { registerOAuthDiscovery, wwwAuthenticate, OAuthDiscoveryConfig } from "./oauth";
import { parseAccounts } from "./accounts";
const { version } = require("../package.json") as { version: string };

const {
  values: { http: useHttp, port },
} = parseArgs({
  options: {
    http: { type: "boolean", default: false },
    port: { type: "string" },
  },
  allowPositionals: true,
});

const resolvedPort = port ? parseInt(port, 10) : 3000;

// One or more mailboxes, from MAIL_ACCOUNTS (JSON) or the legacy flat SMTP_*/IMAP_* env.
const accounts = parseAccounts(process.env);
const anyImap = accounts.some((a) => !!a.imap);
const anySmtp = accounts.some((a) => !!a.smtp);
const anyBoth = accounts.some((a) => !!a.imap && !!a.smtp);

const mcpApiKey = process.env.MCP_API_KEY || "";
const oidcIntrospectionUrl = process.env.OIDC_INTROSPECTION_URL || "";
const oidcClientId = process.env.OIDC_CLIENT_ID || "";
const oidcClientSecret = process.env.OIDC_CLIENT_SECRET || "";

// OAuth discovery for Claude.ai: advertise Authelia as the authorization server
// so the client can run the auth-code flow. Enabled only when both the public URL
// and the issuer are configured.
const publicBaseUrl = (process.env.OAUTH_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const oidcIssuerUrl = (process.env.OIDC_ISSUER_URL || "").replace(/\/+$/, "");
const oauthConfig: OAuthDiscoveryConfig | null =
  publicBaseUrl && oidcIssuerUrl
    ? {
        publicBaseUrl,
        issuerUrl: oidcIssuerUrl,
        scopes: ["openid", "profile", "email", "offline_access"],
        resourceName: "Mail MCP Server",
        resourceDocumentation: "https://github.com/marco2901/smtp-mcp-server",
      }
    : null;

if (!accounts.list.length) {
  console.error(
    "No mailbox configured. Set MAIL_ACCOUNTS (JSON) or the flat SMTP_*/IMAP_* variables."
  );
  process.exit(1);
}

async function isAuthorized(req: Request): Promise<boolean> {
  if (!mcpApiKey) return true;

  const auth = req.headers.authorization || "";

  if (auth === `Bearer ${mcpApiKey}`) {
    console.log("Auth OK: static Bearer token");
    return true;
  }

  if (auth.startsWith("Bearer ") && oidcIntrospectionUrl && oidcClientId && oidcClientSecret) {
    const jwtToken = auth.slice(7);
    console.log("JWT received, starting introspection…");
    try {
      const credentials = Buffer.from(`${oidcClientId}:${oidcClientSecret}`).toString("base64");
      const resp = await fetch(oidcIntrospectionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${credentials}`,
        },
        body: new URLSearchParams({ token: jwtToken }),
        signal: AbortSignal.timeout(5000),
      });
      const data = (await resp.json()) as { active?: boolean };
      console.log(`Introspection: HTTP ${resp.status}, active=${data.active}`);
      return data.active === true;
    } catch (e) {
      console.error("Introspection failed:", e);
    }
  }

  console.warn(`Auth DENIED for ${req.method} ${req.path}`);
  return false;
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  isAuthorized(req).then((ok) => {
    if (ok) {
      next();
    } else {
      if (oauthConfig) {
        res.set("WWW-Authenticate", wwwAuthenticate(oauthConfig));
        res.set("Access-Control-Expose-Headers", "mcp-session-id, WWW-Authenticate");
      }
      res.status(401).send("Unauthorized");
    }
  });
}

async function main() {
  const accountList = accounts.list
    .map((a) => `- ${a.id}: ${a.label}${a.imap ? " [read]" : ""}${a.smtp ? " [send]" : ""}`)
    .join("\n");

  const server = new McpServer(
    { name: "email", version },
    {
      instructions: `
Email MCP Server (IMAP read + SMTP send), multi-mailbox.

This server serves several mailboxes. EVERY tool takes an "account" parameter —
pass one of the ids below. If omitted, the default "${accounts.defaultId}" is used.
Confirm which mailbox when it is ambiguous.

Mailboxes:
${accountList}

Reading (IMAP): list_emails, read_email, search_emails, list_folders,
mark_as_read / mark_as_unread, list_attachments, get_attachment, verify_imap_connection.
Sending (SMTP): send_email (new thread), verify_smtp_connection.
Replying: reply_email (threaded, quotes original; reply_all), forward_email (incl. body + attachments),
draft_email (save draft), send_draft (send a saved draft).

reply_email/forward_email/draft_email SAVE A DRAFT by default — review it, then send with send_draft.
Pass send=true to send in one step. Prefer reply_email over send_email when responding.

Attachments: send/reply/forward/draft accept an "attachments" array — each file as a URL (preferred,
e.g. a Paperless or OneDrive link) or as base64. To hand the user a file FROM an email, use
get_attachment (returns a one-time download link).

UIDs come from list_emails/search_emails and are stable per mailbox+account.
Always confirm the recipient and content with the user before sending.
      `.trim(),
    }
  );

  if (anySmtp) {
    registerEmailTools(server, accounts);
  }

  // Reply / forward / draft need both reading (fetch original, save drafts) and sending.
  if (anyBoth) {
    registerComposeTools(server, accounts);
  }

  // Attachment download tools need a public base URL to hand out download links.
  if (anyImap && publicBaseUrl) {
    registerAttachmentTools(server, accounts, publicBaseUrl);
  }

  if (anyImap) {
    registerImapTools(server, accounts);
  }

  if (useHttp) {
    const app = express();
    app.use(express.json());

    const sseTransports: Record<string, SSEServerTransport> = {};

    // Public OAuth discovery endpoints — MUST be before the auth middleware.
    if (oauthConfig) {
      registerOAuthDiscovery(app, oauthConfig);
    }

    // Public one-time attachment download links — also before the auth middleware
    // (the token in the URL is the capability; Claude.ai/browsers fetch it unauthenticated).
    if (anyImap && publicBaseUrl) {
      registerAttachmentRoute(app);
    }

    app.use(authMiddleware);

    app.post("/mcp", async (req, res) => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => transport.close());
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });

    app.get("/mcp", (_req, res) => {
      res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      }));
    });

    app.delete("/mcp", (_req, res) => {
      res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      }));
    });

    app.get("/sse", async (req, res) => {
      console.log("SSE request received");
      try {
        const transport = new SSEServerTransport("/messages", res);
        sseTransports[transport.sessionId] = transport;
        res.on("close", () => {
          delete sseTransports[transport.sessionId];
          transport.close();
        });
        await server.connect(transport);
      } catch (error) {
        console.error("Error handling SSE request:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });

    app.post("/messages", async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = sseTransports[sessionId];
      if (transport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).send("No transport found for sessionId");
      }
    });

    app.listen(resolvedPort, () => {
      console.log(`SMTP MCP Server listening on port ${resolvedPort}`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((e) => console.error(e.message));
