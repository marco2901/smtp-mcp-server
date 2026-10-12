import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Express, Request, Response } from "express";
import { simpleParser } from "mailparser";
import { z } from "zod/v3";
import { randomBytes } from "node:crypto";
import { promises as fs, createReadStream } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ImapConfig, withClient } from "./imap";

interface StoredFile {
  path: string;
  filename: string;
  contentType: string;
  expiresAt: number;
}

// Short-lived, unguessable download links. Claude.ai discards raw binary blobs
// from tool results, so attachments are handed out as one-time HTTPS links
// (mirrors the Paperless paperless_file_link pattern).
const store = new Map<string, StoredFile>();
const STORE_DIR = path.join(os.tmpdir(), "mcp-attachments");

async function purgeExpired(): Promise<void> {
  const now = Date.now();
  for (const [token, f] of store) {
    if (f.expiresAt <= now) {
      store.delete(token);
      await fs.unlink(f.path).catch(() => {});
    }
  }
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Public GET /files/:token — streams the stored attachment once, then deletes it. */
export function registerAttachmentRoute(app: Express): void {
  app.get("/files/:token", async (req: Request, res: Response) => {
    const token = String(req.params.token);
    await purgeExpired();
    const f = store.get(token);
    if (!f || f.expiresAt <= Date.now()) {
      res.status(404).send("Link expired or not found.");
      return;
    }
    res.setHeader("Content-Type", f.contentType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${f.filename.replace(/"/g, "")}"`
    );
    const stream = createReadStream(f.path);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).send("Read error.");
    });
    stream.on("close", () => {
      // one-time link: remove after the download completes
      store.delete(token);
      fs.unlink(f.path).catch(() => {});
    });
    stream.pipe(res);
  });
}

const listSchema = z.object({
  uid: z.number().describe("UID of the message (from list_emails/search_emails)"),
  mailbox: z.string().optional().describe("Mailbox the message is in (default: INBOX)"),
});

const getSchema = z.object({
  uid: z.number().describe("UID of the message (from list_emails/search_emails)"),
  mailbox: z.string().optional().describe("Mailbox the message is in (default: INBOX)"),
  index: z
    .number()
    .optional()
    .describe("1-based attachment number from list_attachments. Omit if the mail has exactly one."),
  filename: z.string().optional().describe("Alternatively select the attachment by filename."),
});

export interface AttachmentToolsConfig {
  imap: ImapConfig;
  publicBaseUrl: string;
  ttlMinutes?: number;
}

async function fetchAttachments(config: ImapConfig, mailbox: string, uid: number) {
  return withClient(config, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!msg || !msg.source) return null;
      const parsed = await simpleParser(msg.source);
      return (parsed.attachments || []).filter((a) => a.contentDisposition !== "inline" || a.filename);
    } finally {
      lock.release();
    }
  });
}

export function registerAttachmentTools(server: McpServer, cfg: AttachmentToolsConfig) {
  const ttlMs = (cfg.ttlMinutes ?? 15) * 60 * 1000;

  server.tool(
    "list_attachments",
    "List the attachments of an email by UID (with a 1-based index for get_attachment).",
    listSchema.shape,
    async ({ uid, mailbox }: z.infer<typeof listSchema>) => {
      const box = mailbox || "INBOX";
      const atts = await fetchAttachments(cfg.imap, box, uid);
      if (atts === null) return textResult(`Message UID ${uid} not found in "${box}".`);
      if (!atts.length) return textResult(`Message UID ${uid} has no attachments.`);
      const lines = atts.map(
        (a, i) => `${i + 1}. ${a.filename || "unnamed"} — ${a.contentType}, ${a.size} bytes`
      );
      return textResult(`Attachments of UID ${uid}:\n\n${lines.join("\n")}`);
    }
  );

  server.tool(
    "get_attachment",
    "Download an email attachment by UID — returns a short-lived (one-time) HTTPS link to the file. Select by index (from list_attachments) or filename.",
    getSchema.shape,
    async ({ uid, mailbox, index, filename }: z.infer<typeof getSchema>) => {
      const box = mailbox || "INBOX";
      const atts = await fetchAttachments(cfg.imap, box, uid);
      if (atts === null) return textResult(`Message UID ${uid} not found in "${box}".`);
      if (!atts.length) return textResult(`Message UID ${uid} has no attachments.`);

      let att;
      if (filename) {
        att = atts.find((a) => (a.filename || "").toLowerCase() === filename.toLowerCase());
        if (!att) return textResult(`No attachment named "${filename}" on UID ${uid}.`);
      } else if (index) {
        att = atts[index - 1];
        if (!att) return textResult(`No attachment #${index} (message has ${atts.length}).`);
      } else if (atts.length === 1) {
        att = atts[0];
      } else {
        return textResult(
          `Message has ${atts.length} attachments — specify index or filename (see list_attachments).`
        );
      }

      await purgeExpired();
      await fs.mkdir(STORE_DIR, { recursive: true });
      const token = randomBytes(24).toString("hex");
      const safeName = (att.filename || "attachment").replace(/[^\w.\-]/g, "_");
      const filePath = path.join(STORE_DIR, `${token}_${safeName}`);
      await fs.writeFile(filePath, att.content);
      store.set(token, {
        path: filePath,
        filename: att.filename || "attachment",
        contentType: att.contentType || "application/octet-stream",
        expiresAt: Date.now() + ttlMs,
      });

      const url = `${cfg.publicBaseUrl}/files/${token}`;
      const mins = Math.round(ttlMs / 60000);
      return textResult(
        `Download link for "${att.filename || "attachment"}" (${att.contentType}, ${att.size} bytes):\n${url}\n\nOne-time link, valid ~${mins} min.`
      );
    }
  );
}
