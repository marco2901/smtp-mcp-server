import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import nodemailer from "nodemailer";
import { z } from "zod/v3";
import type { Accounts, SmtpConfig } from "../accounts";
import { attachmentInputSchema, toNodemailerAttachments } from "../attach-input";

export type { SmtpConfig } from "../accounts";

/** A cached nodemailer transporter per account id. */
export function makeTransport(smtp: SmtpConfig) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const account = z.string().optional().describe("Which mailbox to send from (see tool description for ids).");

const sendEmailSchema = z.object({
  account,
  to: z.string().describe("Recipient email address (or comma-separated list)"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body (plain text)"),
  html: z.string().optional().describe("Email body as HTML"),
  cc: z.string().optional().describe("CC recipients (comma-separated)"),
  bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
  reply_to: z.string().optional().describe("Reply-To address"),
  from_name: z.string().optional().describe("Sender display name"),
  attachments: attachmentInputSchema,
});

const verifySchema = z.object({ account });

export function registerEmailTools(server: McpServer, accounts: Accounts) {
  const hint = accounts.hint();
  const transports = new Map<string, nodemailer.Transporter>();
  const transportFor = (acc: { id: string; smtp?: SmtpConfig }) => {
    if (!transports.has(acc.id)) transports.set(acc.id, makeTransport(acc.smtp!));
    return transports.get(acc.id)!;
  };

  server.tool(
    "send_email",
    `Send a new email via SMTP (starts a new thread). ${hint}`,
    sendEmailSchema.shape,
    async (args: z.infer<typeof sendEmailSchema>) => {
      let acc, smtp;
      try {
        ({ account: acc, smtp } = accounts.requireSmtp(args.account));
      } catch (e) {
        return textResult((e as Error).message);
      }
      const from = args.from_name ? `"${args.from_name}" <${smtp.from}>` : smtp.from;
      const info = await transportFor(acc).sendMail({
        from,
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        replyTo: args.reply_to,
        subject: args.subject,
        text: args.body,
        html: args.html,
        attachments: toNodemailerAttachments(args.attachments),
      });
      return textResult(
        `Email sent from ${acc.id} (${smtp.from}).\nMessage ID: ${info.messageId}\nAccepted: ${
          info.accepted?.join(", ") || args.to
        }\nRejected: ${info.rejected?.length ? info.rejected.join(", ") : "none"}`
      );
    }
  );

  server.tool(
    "verify_smtp_connection",
    `Verify that the SMTP connection is working. ${hint}`,
    verifySchema.shape,
    async ({ account }: z.infer<typeof verifySchema>) => {
      let acc, smtp;
      try {
        ({ account: acc, smtp } = accounts.requireSmtp(account));
      } catch (e) {
        return textResult((e as Error).message);
      }
      await transportFor(acc).verify();
      return textResult(
        `SMTP connection verified for ${acc.id}.\nHost: ${smtp.host}:${smtp.port}\nFrom: ${smtp.from}`
      );
    }
  );
}
