import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { simpleParser } from "mailparser";
import { z } from "zod/v3";
import type { Accounts, Account, ImapConfig, SmtpConfig } from "../accounts";
import { withClient } from "./imap";
import { attachmentInputSchema, toNodemailerAttachments } from "../attach-input";

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

function buildRaw(mail: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err: Error | null, msg: Buffer) =>
      err ? reject(err) : resolve(msg)
    );
  });
}

async function resolveFolder(client: ImapFlow, specialUse: string, fallbacks: string[]): Promise<string> {
  const list = await client.list();
  const byUse = list.find((m: any) => (m.specialUse || "").toLowerCase() === specialUse.toLowerCase());
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

const account = z.string().optional().describe("Which mailbox to act on (see tool description for ids).");

const replySchema = z.object({
  account,
  uid: z.number().describe("UID of the message to reply to (from list_emails/search_emails)"),
  body: z.string().describe("Your reply text. Inserted ABOVE the quoted original."),
  mailbox: z.string().optional().describe("Mailbox the original is in (default: INBOX)"),
  reply_all: z.boolean().optional().describe("Reply to all original recipients (Cc them). Default false."),
  send: z.boolean().optional().describe("true = send immediately. false (default) = save a draft for review."),
  to: z.string().optional().describe("Override To recipients (comma-separated). Default: original sender."),
  cc: z.string().optional().describe("Override Cc recipients (comma-separated)."),
  from_name: z.string().optional().describe("Sender display name."),
  attachments: attachmentInputSchema,
});

const forwardSchema = z.object({
  account,
  uid: z.number().describe("UID of the message to forward"),
  to: z.string().describe("Recipient(s) to forward to (comma-separated)"),
  body: z.string().optional().describe("Your comment. Inserted ABOVE the forwarded original."),
  mailbox: z.string().optional().describe("Mailbox the original is in (default: INBOX)"),
  send: z.boolean().optional().describe("true = send immediately. false (default) = save a draft for review."),
  cc: z.string().optional().describe("Cc recipients (comma-separated)."),
  from_name: z.string().optional().describe("Sender display name."),
  attachments: attachmentInputSchema.describe("Extra files to attach, in addition to the forwarded original's attachments."),
});

const draftSchema = z.object({
  account,
  to: z.string().describe("Recipient email address (or comma-separated list)"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body (plain text)"),
  html: z.string().optional().describe("Email body as HTML"),
  cc: z.string().optional().describe("Cc recipients (comma-separated)"),
  bcc: z.string().optional().describe("Bcc recipients (comma-separated)"),
  from_name: z.string().optional().describe("Sender display name"),
  attachments: attachmentInputSchema,
});

const sendDraftSchema = z.object({
  account,
  uid: z.number().describe("UID of the draft to send (from list_emails on the Drafts folder)"),
  mailbox: z.string().optional().describe("Drafts mailbox (default: auto-detected \\Drafts folder)"),
});

export function registerComposeTools(server: McpServer, accounts: Accounts) {
  const hint = accounts.hint();
  const transports = new Map<string, nodemailer.Transporter>();
  const transportFor = (smtp: SmtpConfig, id: string) => {
    if (!transports.has(id)) {
      transports.set(
        id,
        nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: { user: smtp.user, pass: smtp.pass },
        })
      );
    }
    return transports.get(id)!;
  };

  // Resolve an account that has BOTH imap and smtp; returns null + error text otherwise.
  const resolveBoth = (
    id?: string
  ): { account: Account; imap: ImapConfig; smtp: SmtpConfig } | { error: string } => {
    let acc: Account;
    try {
      acc = accounts.resolve(id);
    } catch (e) {
      return { error: (e as Error).message };
    }
    if (!acc.imap || !acc.smtp)
      return { error: `Account "${acc.id}" needs both IMAP and SMTP for reply/forward/draft.` };
    return { account: acc, imap: acc.imap, smtp: acc.smtp };
  };

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
    `Reply to an email by UID — preserves the thread and quotes the original. Saves a draft by default; send=true sends now. ${hint}`,
    replySchema.shape,
    async (args: z.infer<typeof replySchema>) => {
      const r = resolveBoth(args.account);
      if ("error" in r) return textResult(r.error);
      const { imap, smtp } = r;
      const selfAddrs = new Set([smtp.user.toLowerCase(), smtp.from.toLowerCase()]);
      const box = args.mailbox || "INBOX";
      return withClient(imap, async (client) => {
        const orig = await fetchParsed(client, box, args.uid);
        if (!orig) return textResult(`Message UID ${args.uid} not found in "${box}".`);
        const p = orig.parsed as any;

        const toRec = args.to || addrString(addrList(p.from));
        const ccRec =
          args.cc ||
          (args.reply_all
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
          from: args.from_name ? `"${args.from_name}" <${smtp.from}>` : smtp.from,
          to: toRec,
          cc: ccRec,
          subject,
          inReplyTo: p.messageId,
          references: refs.join(" "),
          text: `${args.body}\n\n${quoteOriginal(p)}`,
          attachments: toNodemailerAttachments(args.attachments),
        };

        if (args.send) {
          const info = await transportFor(smtp, r.account.id).sendMail(mail);
          await saveToSent(client, await buildRaw(mail));
          return textResult(
            `Reply sent from ${r.account.id} to ${toRec}${ccRec ? ` (cc ${ccRec})` : ""}.\nMessage ID: ${info.messageId}`
          );
        }
        const drafts = await resolveFolder(client, "\\Drafts", DRAFT_FALLBACKS);
        const res = await client.append(drafts, await buildRaw(mail), ["\\Draft"]);
        const uidInfo = res && (res as any).uid ? ` (UID ${(res as any).uid})` : "";
        return textResult(`Reply draft saved to "${drafts}"${uidInfo}. Review it, then send with send_draft.`);
      });
    }
  );

  server.tool(
    "forward_email",
    `Forward an email by UID, including the original body and attachments. Saves a draft by default; send=true sends now. ${hint}`,
    forwardSchema.shape,
    async (args: z.infer<typeof forwardSchema>) => {
      const r = resolveBoth(args.account);
      if ("error" in r) return textResult(r.error);
      const { imap, smtp } = r;
      const box = args.mailbox || "INBOX";
      return withClient(imap, async (client) => {
        const orig = await fetchParsed(client, box, args.uid);
        if (!orig) return textResult(`Message UID ${args.uid} not found in "${box}".`);
        const p = orig.parsed as any;

        const subject = /^fwd?:/i.test(p.subject || "") ? p.subject : `Fwd: ${p.subject || ""}`;
        const header =
          `---------- Forwarded message ----------\n` +
          `From: ${addrString(addrList(p.from))}\n` +
          `Date: ${p.date ? new Date(p.date).toString() : ""}\n` +
          `Subject: ${p.subject || ""}\n` +
          `To: ${addrString(addrList(p.to))}\n\n`;
        const originalAttachments = (p.attachments || []).map((a: any) => ({
          filename: a.filename || "attachment",
          content: a.content,
          contentType: a.contentType,
        }));
        const extraAttachments = toNodemailerAttachments(args.attachments) || [];

        const mail: Record<string, unknown> = {
          from: args.from_name ? `"${args.from_name}" <${smtp.from}>` : smtp.from,
          to: args.to,
          cc: args.cc,
          subject,
          references: [p.references, p.messageId].flat().filter(Boolean).join(" "),
          text: `${args.body ? args.body + "\n\n" : ""}${header}${p.text || (p.html ? stripHtml(p.html) : "")}`,
          attachments: [...originalAttachments, ...extraAttachments],
        };

        if (args.send) {
          const info = await transportFor(smtp, r.account.id).sendMail(mail);
          await saveToSent(client, await buildRaw(mail));
          return textResult(`Forwarded from ${r.account.id} to ${args.to}.\nMessage ID: ${info.messageId}`);
        }
        const drafts = await resolveFolder(client, "\\Drafts", DRAFT_FALLBACKS);
        const res = await client.append(drafts, await buildRaw(mail), ["\\Draft"]);
        const uidInfo = res && (res as any).uid ? ` (UID ${(res as any).uid})` : "";
        return textResult(`Forward draft saved to "${drafts}"${uidInfo}. Review it, then send with send_draft.`);
      });
    }
  );

  server.tool(
    "draft_email",
    `Create and save a new email draft to the Drafts folder (does not send). ${hint}`,
    draftSchema.shape,
    async (args: z.infer<typeof draftSchema>) => {
      const r = resolveBoth(args.account);
      if ("error" in r) return textResult(r.error);
      const { imap, smtp } = r;
      return withClient(imap, async (client) => {
        const mail: Record<string, unknown> = {
          from: args.from_name ? `"${args.from_name}" <${smtp.from}>` : smtp.from,
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          text: args.body,
          html: args.html,
          attachments: toNodemailerAttachments(args.attachments),
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
    `Send an existing draft by UID, then move a copy to Sent and remove the draft. ${hint}`,
    sendDraftSchema.shape,
    async (args: z.infer<typeof sendDraftSchema>) => {
      const r = resolveBoth(args.account);
      if ("error" in r) return textResult(r.error);
      const { imap, smtp } = r;
      return withClient(imap, async (client) => {
        const box = args.mailbox || (await resolveFolder(client, "\\Drafts", DRAFT_FALLBACKS));
        const draft = await fetchParsed(client, box, args.uid);
        if (!draft) return textResult(`Draft UID ${args.uid} not found in "${box}".`);
        const p = draft.parsed as any;
        const rcpt = [...addrList(p.to), ...addrList(p.cc), ...addrList(p.bcc)]
          .map((a) => a.address)
          .filter(Boolean) as string[];
        if (!rcpt.length) return textResult(`Draft UID ${args.uid} has no recipients — not sent.`);

        const info = await transportFor(smtp, r.account.id).sendMail({
          envelope: { from: smtp.from, to: rcpt },
          raw: draft.source,
        });
        await saveToSent(client, draft.source);
        const lock = await client.getMailboxLock(box);
        try {
          await client.messageDelete(String(args.uid), { uid: true });
        } finally {
          lock.release();
        }
        return textResult(`Draft sent from ${r.account.id} to ${rcpt.join(", ")}.\nMessage ID: ${info.messageId}`);
      });
    }
  );
}
