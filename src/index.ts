#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { NextFunction, Request, Response } from "express";

import { parseArgs } from "node:util";
import { registerEmailTools } from "./tools/email";
import { registerImapTools } from "./tools/imap";
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

const smtpHost = process.env.SMTP_HOST || "";
const smtpPort = parseInt(process.env.SMTP_PORT || "587", 10);
const smtpSecure = process.env.SMTP_SECURE === "true";
const smtpUser = process.env.SMTP_USER || "";
const smtpPass = process.env.SMTP_PASS || "";
const smtpFrom = process.env.SMTP_FROM || smtpUser;

// IMAP defaults to TLS on 993; falls back to the SMTP user/pass so a single
// mailbox only needs one credential set when host/user are shared.
const imapHost = process.env.IMAP_HOST || "";
const imapPort = parseInt(process.env.IMAP_PORT || "993", 10);
const imapSecure = process.env.IMAP_SECURE ? process.env.IMAP_SECURE === "true" : true;
const imapUser = process.env.IMAP_USER || smtpUser;
const imapPass = process.env.IMAP_PASS || smtpPass;

const mcpApiKey = process.env.MCP_API_KEY || "";
const oidcIntrospectionUrl = process.env.OIDC_INTROSPECTION_URL || "";
const oidcClientId = process.env.OIDC_CLIENT_ID || "";
const oidcClientSecret = process.env.OIDC_CLIENT_SECRET || "";

const smtpEnabled = Boolean(smtpHost && smtpUser && smtpPass);
const imapEnabled = Boolean(imapHost && imapUser && imapPass);

if (!smtpEnabled && !imapEnabled) {
  console.error(
    "No mailbox configured. Set SMTP_HOST/SMTP_USER/SMTP_PASS (sending) and/or IMAP_HOST/IMAP_USER/IMAP_PASS (reading)."
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
      res.status(401).send("Unauthorized");
    }
  });
}

async function main() {
  const server = new McpServer(
    { name: "email", version },
    {
      instructions: `
Email MCP Server (IMAP read + SMTP send)

Use this server to read and send emails on behalf of the user.

Reading (IMAP)${imapEnabled ? "" : " — DISABLED (no IMAP config)"}:
- list_emails: List the most recent emails in a mailbox (default INBOX)
- read_email: Read the full content of a message by UID
- search_emails: Search by sender, recipient, subject, body, date range, or unread state
- list_folders: List all available mailboxes/folders
- mark_as_read / mark_as_unread: Toggle the read state of a message
- verify_imap_connection: Check that IMAP is reachable and credentials are valid

Sending (SMTP)${smtpEnabled ? "" : " — DISABLED (no SMTP config)"}:
- send_email: Send an email with subject, body (plain text and/or HTML), optional CC/BCC/Reply-To
- verify_smtp_connection: Check that SMTP is reachable and credentials are valid

${smtpEnabled ? `Default sender address: ${smtpFrom}\n` : ""}UIDs come from list_emails/search_emails and are stable per mailbox — pass them to read_email/mark_as_read.
Always confirm the recipient and content with the user before sending.
      `.trim(),
    }
  );

  if (smtpEnabled) {
    registerEmailTools(server, {
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      user: smtpUser,
      pass: smtpPass,
      from: smtpFrom,
    });
  }

  if (imapEnabled) {
    registerImapTools(server, {
      host: imapHost,
      port: imapPort,
      secure: imapSecure,
      user: imapUser,
      pass: imapPass,
    });
  }

  if (useHttp) {
    const app = express();
    app.use(express.json());

    const sseTransports: Record<string, SSEServerTransport> = {};

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
