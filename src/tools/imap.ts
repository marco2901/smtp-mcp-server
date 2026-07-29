import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { z } from "zod/v3";

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/**
 * Open a short-lived IMAP connection, run `fn`, then always log out.
 * Connecting per call keeps things simple and avoids stale-socket issues —
 * MCP calls are infrequent enough that the connection overhead is negligible.
 */
async function withClient<T>(
  config: ImapConfig,
  fn: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore logout errors — the work is already done
    }
  }
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function formatAddress(addr: any): string {
  if (!addr) return "";
  const list = Array.isArray(addr) ? addr : [addr];
  return list
    .map((a: any) => (a?.name ? `${a.name} <${a.address}>` : a?.address || ""))
    .filter(Boolean)
    .join(", ");
}

const listSchema = z.object({
  mailbox: z.string().optional().describe("Mailbox/folder to list (default: INBOX)"),
  limit: z.number().optional().describe("Max number of most-recent messages to return (default: 20)"),
  unseen_only: z.boolean().optional().describe("Only return unread messages (default: false)"),
});

const readSchema = z.object({
  uid: z.number().describe("The UID of the message to read (from list_emails/search_emails)"),
  mailbox: z.string().optional().describe("Mailbox/folder the message is in (default: INBOX)"),
  mark_seen: z.boolean().optional().describe("Mark the message as read when opening (default: false)"),
});

const searchSchema = z.object({
  mailbox: z.string().optional().describe("Mailbox/folder to search (default: INBOX)"),
  from: z.string().optional().describe("Match sender address/name substring"),
  to: z.string().optional().describe("Match recipient address/name substring"),
  subject: z.string().optional().describe("Match subject substring"),
  body: z.string().optional().describe("Match text anywhere in the body"),
  since: z.string().optional().describe("Only messages on/after this date (YYYY-MM-DD)"),
  before: z.string().optional().describe("Only messages before this date (YYYY-MM-DD)"),
  unseen_only: z.boolean().optional().describe("Only unread messages (default: false)"),
  limit: z.number().optional().describe("Max number of matches to return (default: 20)"),
});

const flagSchema = z.object({
  uid: z.number().describe("The UID of the message"),
  mailbox: z.string().optional().describe("Mailbox/folder the message is in (default: INBOX)"),
});

export function registerImapTools(server: McpServer, config: ImapConfig) {
  const summarize = (msg: any): string => {
    const env = msg.envelope || {};
    const flags: string[] = Array.isArray(msg.flags)
      ? msg.flags
      : msg.flags
      ? Array.from(msg.flags)
      : [];
    const unread = flags.includes("\\Seen") ? "" : " [UNREAD]";
    const date = env.date ? new Date(env.date).toISOString().slice(0, 16).replace("T", " ") : "";
    return `UID ${msg.uid}${unread} | ${date} | From: ${formatAddress(env.from)} | ${
      env.subject || "(no subject)"
    }`;
  };

  server.tool(
    "list_emails",
    "List the most recent emails in a mailbox (IMAP)",
    listSchema.shape,
    async ({ mailbox, limit, unseen_only }: z.infer<typeof listSchema>) => {
      const box = mailbox || "INBOX";
      const max = limit ?? 20;
      return withClient(config, async (client) => {
        const lock = await client.getMailboxLock(box);
        try {
          let uids: number[];
          if (unseen_only) {
            uids = (await client.search({ seen: false }, { uid: true })) || [];
          } else {
            const status = client.mailbox;
            const total = status && typeof status !== "boolean" ? status.exists : 0;
            if (!total) return textResult(`Mailbox "${box}" is empty.`);
            // sequence range for the last `max` messages
            const startSeq = Math.max(1, total - max + 1);
            const seqUids: number[] = [];
            for await (const msg of client.fetch(`${startSeq}:*`, { uid: true })) {
              seqUids.push(msg.uid);
            }
            uids = seqUids;
          }
          if (!uids.length) return textResult(`No matching messages in "${box}".`);
          const recent = uids.slice(-max).reverse();
          const lines: string[] = [];
          for await (const msg of client.fetch(
            { uid: recent.join(",") },
            { uid: true, envelope: true, flags: true }
          )) {
            lines.push(summarize(msg));
          }
          // fetch() returns in ascending order; restore newest-first
          lines.reverse();
          return textResult(
            `Mailbox "${box}" — ${lines.length} message(s), newest first:\n\n${lines.join("\n")}`
          );
        } finally {
          lock.release();
        }
      });
    }
  );

  server.tool(
    "read_email",
    "Read the full content of an email by UID (IMAP)",
    readSchema.shape,
    async ({ uid, mailbox, mark_seen }: z.infer<typeof readSchema>) => {
      const box = mailbox || "INBOX";
      return withClient(config, async (client) => {
        const lock = await client.getMailboxLock(box);
        try {
          const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
          if (!msg || !msg.source) return textResult(`Message UID ${uid} not found in "${box}".`);
          const parsed = await simpleParser(msg.source);
          if (mark_seen) {
            await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true });
          }
          const attachments = (parsed.attachments || [])
            .map((a) => `${a.filename || "unnamed"} (${a.contentType}, ${a.size} bytes)`)
            .join(", ");
          const parts = [
            `Subject: ${parsed.subject || "(no subject)"}`,
            `From: ${formatAddress(parsed.from?.value)}`,
            `To: ${formatAddress(parsed.to && (parsed.to as any).value)}`,
            parsed.cc ? `Cc: ${formatAddress((parsed.cc as any).value)}` : "",
            `Date: ${parsed.date ? parsed.date.toISOString() : ""}`,
            attachments ? `Attachments: ${attachments}` : "",
            "",
            (parsed.text || parsed.html || "(no text body)").toString().trim(),
          ].filter((l) => l !== "");
          return textResult(parts.join("\n"));
        } finally {
          lock.release();
        }
      });
    }
  );

  server.tool(
    "search_emails",
    "Search emails by sender, subject, body, date range, or unread state (IMAP)",
    searchSchema.shape,
    async (args: z.infer<typeof searchSchema>) => {
      const box = args.mailbox || "INBOX";
      const max = args.limit ?? 20;
      return withClient(config, async (client) => {
        const lock = await client.getMailboxLock(box);
        try {
          const query: Record<string, unknown> = {};
          if (args.from) query.from = args.from;
          if (args.to) query.to = args.to;
          if (args.subject) query.subject = args.subject;
          if (args.body) query.body = args.body;
          if (args.since) query.since = new Date(args.since);
          if (args.before) query.before = new Date(args.before);
          if (args.unseen_only) query.seen = false;
          if (Object.keys(query).length === 0) query.all = true;

          const uids = (await client.search(query, { uid: true })) || [];
          if (!uids.length) return textResult(`No messages matched in "${box}".`);
          const recent = uids.slice(-max).reverse();
          const lines: string[] = [];
          for await (const msg of client.fetch(
            { uid: recent.join(",") },
            { uid: true, envelope: true, flags: true }
          )) {
            lines.push(summarize(msg));
          }
          lines.reverse();
          return textResult(
            `Search in "${box}" — ${lines.length} of ${uids.length} match(es), newest first:\n\n${lines.join(
              "\n"
            )}`
          );
        } finally {
          lock.release();
        }
      });
    }
  );

  server.tool(
    "list_folders",
    "List all available IMAP mailboxes/folders",
    {},
    async () => {
      return withClient(config, async (client) => {
        const list = await client.list();
        const lines = list.map((m) => `${m.path}${m.subscribed ? "" : " (not subscribed)"}`);
        return textResult(`Mailboxes:\n\n${lines.join("\n")}`);
      });
    }
  );

  server.tool(
    "mark_as_read",
    "Mark an email as read (adds the \\Seen flag) by UID",
    flagSchema.shape,
    async ({ uid, mailbox }: z.infer<typeof flagSchema>) => {
      const box = mailbox || "INBOX";
      return withClient(config, async (client) => {
        const lock = await client.getMailboxLock(box);
        try {
          const ok = await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true });
          return textResult(ok ? `Marked UID ${uid} as read.` : `Could not update UID ${uid}.`);
        } finally {
          lock.release();
        }
      });
    }
  );

  server.tool(
    "mark_as_unread",
    "Mark an email as unread (removes the \\Seen flag) by UID",
    flagSchema.shape,
    async ({ uid, mailbox }: z.infer<typeof flagSchema>) => {
      const box = mailbox || "INBOX";
      return withClient(config, async (client) => {
        const lock = await client.getMailboxLock(box);
        try {
          const ok = await client.messageFlagsRemove({ uid: String(uid) }, ["\\Seen"], { uid: true });
          return textResult(ok ? `Marked UID ${uid} as unread.` : `Could not update UID ${uid}.`);
        } finally {
          lock.release();
        }
      });
    }
  );

  server.tool(
    "verify_imap_connection",
    "Verify that the IMAP connection is working",
    {},
    async () => {
      return withClient(config, async (client) => {
        const box = await client.getMailboxLock("INBOX");
        try {
          const status = client.mailbox;
          const exists = status && typeof status !== "boolean" ? status.exists : 0;
          return textResult(
            `IMAP connection verified.\nHost: ${config.host}:${config.port}\nUser: ${config.user}\nINBOX messages: ${exists}`
          );
        } finally {
          box.release();
        }
      });
    }
  );
}
