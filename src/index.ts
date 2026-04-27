#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { NextFunction, Request, Response } from "express";

import { parseArgs } from "node:util";
import { registerEmailTools } from "./tools/email";
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

const mcpApiKey = process.env.MCP_API_KEY || "";
const oidcIntrospectionUrl = process.env.OIDC_INTROSPECTION_URL || "";
const oidcClientId = process.env.OIDC_CLIENT_ID || "";
const oidcClientSecret = process.env.OIDC_CLIENT_SECRET || "";

if (!smtpHost || !smtpUser || !smtpPass) {
  console.error("Missing required SMTP environment variables: SMTP_HOST, SMTP_USER, SMTP_PASS");
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
    { name: "smtp-email", version },
    {
      instructions: `
SMTP Email MCP Server

Use this server to send emails on behalf of the user.

Available tools:
- send_email: Send an email with subject, body (plain text and/or HTML), optional CC/BCC/Reply-To
- verify_smtp_connection: Check that the SMTP server is reachable and credentials are valid

Default sender address: ${smtpFrom}
Always confirm the recipient and content with the user before sending.
      `.trim(),
    }
  );

  registerEmailTools(server, {
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    user: smtpUser,
    pass: smtpPass,
    from: smtpFrom,
  });

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
