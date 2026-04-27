import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import nodemailer from "nodemailer";
import { z } from "zod/v3";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

const sendEmailSchema = z.object({
  to: z.string().describe("Recipient email address (or comma-separated list)"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body (plain text)"),
  html: z.string().optional().describe("Email body as HTML"),
  cc: z.string().optional().describe("CC recipients (comma-separated)"),
  bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
  reply_to: z.string().optional().describe("Reply-To address"),
  from_name: z.string().optional().describe("Sender display name"),
});

type SendEmailInput = z.infer<typeof sendEmailSchema>;

export function registerEmailTools(server: McpServer, config: SmtpConfig) {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });

  server.tool(
    "send_email",
    "Send an email via SMTP",
    sendEmailSchema.shape,
    async ({ to, subject, body, html, cc, bcc, reply_to, from_name }: SendEmailInput) => {
      const from = from_name
        ? `"${from_name}" <${config.from}>`
        : config.from;

      const info = await transporter.sendMail({
        from,
        to,
        cc,
        bcc,
        replyTo: reply_to,
        subject,
        text: body,
        html,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Email sent successfully.\nMessage ID: ${info.messageId}\nAccepted: ${info.accepted?.join(", ") || to}\nRejected: ${info.rejected?.length ? info.rejected.join(", ") : "none"}`,
          },
        ],
      };
    }
  );

  server.tool(
    "verify_smtp_connection",
    "Verify that the SMTP connection is working",
    {},
    async () => {
      await transporter.verify();
      return {
        content: [
          {
            type: "text" as const,
            text: `SMTP connection verified successfully.\nHost: ${config.host}:${config.port}\nUser: ${config.user}\nFrom: ${config.from}`,
          },
        ],
      };
    }
  );
}
