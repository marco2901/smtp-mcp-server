import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { simpleParser } from "mailparser";
import { z } from "zod/v3";
import { ImapConfig, withClient } from "./imap";
import { SmtpConfig } from "./email";

export interface ComposeConfig {
  imap: ImapConfig;
  smtp: SmtpConfig;
}

type Addr = { address?: string; name?: string };

function addrList(a: any): Addr[] {
  if (!a) return [];
  const objs = Array.isArray(a) ? a : [a];
  const out: Addr[] = [];
  for (const o of objs) if (o && Array.isArray(o.value)) out.push(...o.value);
  return out;
}

function addrString(list: Addr[]): string {
  return list
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address || ""))
    .filter(Boolean)
    .join(", ");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function quoteOriginal(parsed: any): string {
  const from = addrString(addrList(parsed.from)) || "sender";
  const date = parsed.date ? new Date(parsed.date).toString() : "";
  const original = (parsed.text || (parsed.html ? stripHtml(parsed.html) : "") || "").trim();
  const quoted = original
    .split("\n")
    .map((l: string) => `> ${l}`)
    .join("\n");
  return `On ${date}, ${from} wrote:\n${quoted}`;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Build the raw RFC822 bytes for a nodemailer mail object (for IMAP APPEND). */
function buildRaw(mail: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err: Error | null, msg: Buffer) =>
      err ? reject(err) : resolve(msg)
    );
  });
}

/** Resolve a special-use folder (\Drafts, \Sent) by its IMAP attribute, with name fallbacks. */
async function resolveFolder(
  client: ImapFlow,
  specialUse: string,
  fallbacks: string[]
): Promise<string> {
  const list = await client.list();
  const byUse = list.find(
    (m: any) => (m.specialUse || "").toLowerCase() === specialUse.toLowerCase()
  );
  if (byUse) return byUse.path;
  const lower = fallbacks.map((f) => f.toLowerCase());
  const byName = list.find((m: any) => {
    const p = m.path.toLowerCase();
    return lower.some((f) => p === f || p.endsWith("." + f) || p.endsWith("/" + f));
  });
  return byName ? byName.path : fallbacks[0];
}

const DRAFT_FALLBACKS = ["Drafts", "Entwürfe", "Entwurf", "INBOX.Drafts"];
const SENT_FALLBACKS = ["Sent", "Gesendet", "Sent Items", "Gesendete Objekte", "INBOX.Sent"];

/** Fetch one message's raw source + parsed form from a mailbox by UID. */
async function fetchParsed(client: ImapFlow, mailbox: string, uid: number) {
  const lock = await client.getMailboxLock(mailbox);
  try {
    const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    const parsed = await simpleParser(msg.source);
    return { source: msg.source as Buffer, parsed };
  } finally {
    lock.release();
  }
}

const replySchema = z.object({
  uid: z.number().describe("UID of the message to reply to (from list_emails/search_emails)"),
  body: z.string().describe("Your reply text. Inserted ABOVE the quoted original."),
  mailbox: z.string().optional().describe("Mailbox the original is in (default: INBOX)"),
  reply_all: z.boolean().optional().describe("Reply to all original recipients (Cc them). Default false."),
  send: z.boolean().optional().describe("true = send immediately. false (default) = save a draft for review."),
  to: z.string().optional().describe("Override To recipients (comma-separated). Default: original sender."),
  cc: z.string().optional().describe("Override Cc recipients (comma-separated)."),
  from_name: z.string().optional().describe("Sender display name."),
});

const forwardSchema = z.object({
  uid: z.number().describe("UID of the message to forward"),
  to: z.string().describe("Recipient(s) to forward to (comma-separated)"),
  body: z.string().optional().describe("Your comment. Inserted ABOVE the forwarded original."),
  mailbox: z.string().optional().describe("Mailbox the original is in (default: INBOX)"),
  send: z.boolean().optional().describe("true = send immediately. false (default) = save a draft for review."),
  cc: z.string().optional().describe("Cc recipients (comma-separated)."),
  from_name: z.string().optional().describe("Sender display name."),
});

const draftSchema = z.object({
  to: z.string().describe("Recipient email address (or comma-separated list)"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body (plain text)"),
  html: z.string().optional().describe("Email body as HTML"),
  cc: z.string().optional().describe("Cc recipients (comma-separated)"),
  bcc: z.string().optional().describe("Bcc recipients (comma-separated)"),
  from_name: z.string().optional().describe("Sender display name"),
});

const sendDraftSchema = z.object({
  uid: z.number().describe("UID of the draft to send (from list_emails on the Drafts folder)"),
  mailbox: z.string().optional().describe("Drafts mailbox (default: auto-detected \\Drafts folder)"),
});

export function registerComposeTools(server: McpServer, cfg: ComposeConfig) {
  const transporter = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
  });
  const fromHeader = (name?: string) => (name ? `"${name}" <${cfg.smtp.from}>` : cfg.smtp.from);
  const selfAddrs = new Set([cfg.smtp.user.toLowerCase(), cfg.smtp.from.toLowerCase()]);

  // Save a sent copy to the Sent folder (best-effort — never fail the send over this).
  const saveToSent = async (client: ImapFlow, raw: Buffer) => {
    try {
      const sent = await resolveFolder(client, "\\Sent", SENT_FALLBACKS);
      await client.append(sent, raw, ["\\Seen"]);
    } catch (e) {
      console.warn("Could not save to Sent:", (e as Error).message);
    }
  };

  server.tool(
    "reply_email",
    "Reply to an email by UID — preserves the thread (In-Reply-To/References) and quotes the original. Saves a draft by default; pass send=true to send immediately.",
    replySchema.shape,
    async ({ uid, body, mailbox, reply_all, send, to, cc, from_name }: z.infer<typeof replySchema>) => {
      const box = mailbox || "INBOX";
      return withClient(cfg.imap, async (client) => {
        const orig = await fetchParsed(client, box, uid);
        if (!orig) return textResult(`Message UID ${uid} not found in "${box}".`);
        const p = orig.parsed as any;

        const toRec = to || addrString(addrList(p.from));
        const ccRec =
          cc ||
          (reply_all
            ? addrString(
                [...addrList(p.to), ...addrList(p.cc)].filter(
                  (a) => !selfAddrs.has((a.address || "").toLowerCase())
                )
              ) || undefined
            : undefined);
        const subject = /^re:/i.test(p.subject || "") ? p.subject : `Re: ${p.subject || ""}`;
        const refs = [
          ...(p.references ? (Array.isArray(p.references) ? p.references : [p.references]) : []),
          p.messageId,
        ].filter(Boolean);

        const mail: Record<string, unknown> = {
          from: fromHeader(from_name),
          to: toRec,
          cc: ccRec,
          subject,
          inReplyTo: p.messageId,
          references: refs.join(" "),
          text: `${body}\n\n${quoteOriginal(p)}`,
        };

        if (send) {
          const info = await transporter.sendMail(mail);
          await saveToSent(client, await buildRaw(mail));
          return textResult(
            `Reply sent to ${toRec}${ccRec ? ` (cc ${ccRec})` : ""}.\nMessage ID: ${info.messageId}`
          );
        }
        const drafts = await resolveFolder(client, "\\Drafts", DRAFT_FALLBACKS);
        const res = await client.append(drafts, await buildRaw(mail), ["\\Draft"]);
        const uidInfo = res && (res as any).uid ? ` (UID ${(res as any).uid})` : "";
        return textResult(
          `Reply draft saved to "${drafts}"${uidInfo}. Review it, then send with send_draft.`
        );
      });
    }
  );

  server.tool(
    "forward_email",
    "Forward an email by UID to new recipients, including the original body and attachments. Saves a draft by default; pass send=true to send immediately.",
    forwardSchema.shape,
    async ({ uid, to, body, mailbox, send, cc, from_name }: z.infer<typeof forwardSchema>) => {
      const box = mailbox || "INBOX";
      return withClient(cfg.imap, async (client) => {
        const orig = await fetchParsed(client, box, uid);
        if (!orig) return textResult(`Message UID ${uid} not found in "${box}".`);
        const p = orig.parsed as any;

        const subject = /^fwd?:/i.test(p.subject || "") ? p.subject : `Fwd: ${p.subject || ""}`;
        const header =
          `---------- Forwarded message ----------\n` +
          `From: ${addrString(addrList(p.from))}\n` +
          `Date: ${p.date ? new Date(p.date).toString() : ""}\n` +
          `Subject: ${p.subject || ""}\n` +
          `To: ${addrString(addrList(p.to))}\n\n`;
        const attachments = (p.attachments || []).map((a: any) => ({
          filename: a.filename || "attachment",
          content: a.content,
          contentType: a.contentType,
        }));

        const mail: Record<string, unknown> = {
          from: fromHeader(from_name),
          to,
          cc,
          subject,
          references: [p.references, p.messageId].flat().filter(Boolean).join(" "),
          text: `${body ? body + "\n\n" : ""}${header}${p.text || (p.html ? stripHtml(p.html) : "")}`,
          attachments,
        };

        if (send) {
          const info = await transporter.sendMail(mail);
          await saveToSent(client, await buildRaw(mail));
          return textResult(`Forwarded to ${to}.\nMessage ID: ${info.messageId}`);
        }
        const drafts = await resolveFolder(client, "\\Drafts", DRAFT_FALLBACKS);
        const res = await client.append(drafts, await buildRaw(mail), ["\\Draft"]);
        const uidInfo = res && (res as any).uid ? ` (UID ${(res as any).uid})` : "";
        return textResult(
          `Forward draft saved to "${drafts}"${uidInfo}. Review it, then send with send_draft.`
        );
      });
    }
  );

  server.tool(
    "draft_email",
    "Create and save a new email draft to the Drafts folder (does not send). Send it later with send_draft.",
    draftSchema.shape,
    async ({ to, subject, body, html, cc, bcc, from_name }: z.infer<typeof draftSchema>) => {
      return withClient(cfg.imap, async (client) => {
        const mail: Record<string, unknown> = {
          from: fromHeader(from_name),
          to,
          cc,
          bcc,
          subject,
          text: body,
          html,
        };
        const drafts = await resolveFolder(client, "\\Drafts", DRAFT_FALLBACKS);
        const res = await client.append(drafts, await buildRaw(mail), ["\\Draft"]);
        const uidInfo = res && (res as any).uid ? ` (UID ${(res as any).uid})` : "";
        return textResult(`Draft saved to "${drafts}"${uidInfo}. Send it with send_draft.`);
      });
    }
  );

  server.tool(
    "send_draft",
    "Send an existing draft by UID (from the Drafts folder), then move a copy to Sent and remove the draft. Threading of reply/forward drafts is preserved.",
    sendDraftSchema.shape,
    async ({ uid, mailbox }: z.infer<typeof sendDraftSchema>) => {
      return withClient(cfg.imap, async (client) => {
        const box = mailbox || (await resolveFolder(client, "\\Drafts", DRAFT_FALLBACKS));
        const draft = await fetchParsed(client, box, uid);
        if (!draft) return textResult(`Draft UID ${uid} not found in "${box}".`);
        const p = draft.parsed as any;
        const rcpt = [...addrList(p.to), ...addrList(p.cc), ...addrList(p.bcc)]
          .map((a) => a.address)
          .filter(Boolean) as string[];
        if (!rcpt.length) return textResult(`Draft UID ${uid} has no recipients — not sent.`);

        const info = await transporter.sendMail({
          envelope: { from: cfg.smtp.from, to: rcpt },
          raw: draft.source,
        });
        await saveToSent(client, draft.source);
        const lock = await client.getMailboxLock(box);
        try {
          await client.messageDelete(String(uid), { uid: true });
        } finally {
          lock.release();
        }
        return textResult(`Draft sent to ${rcpt.join(", ")}.\nMessage ID: ${info.messageId}`);
      });
    }
  );
}
