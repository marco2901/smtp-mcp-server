// Central mailbox configuration. The server can serve several mailboxes at once;
// each tool takes an optional `account` id and resolves its IMAP/SMTP config here.

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface Account {
  id: string;
  label: string;
  imap?: ImapConfig;
  smtp?: SmtpConfig;
}

export class Accounts {
  constructor(public readonly list: Account[], public readonly defaultId: string) {}

  ids(): string[] {
    return this.list.map((a) => a.id);
  }

  /** Resolve an account by id, falling back to the default. Throws on unknown id. */
  resolve(id?: string): Account {
    const wanted = id || this.defaultId;
    const acc = this.list.find((a) => a.id === wanted);
    if (!acc) {
      throw new Error(`Unknown account "${wanted}". Available: ${this.ids().join(", ")}.`);
    }
    return acc;
  }

  requireImap(id?: string): { account: Account; imap: ImapConfig } {
    const account = this.resolve(id);
    if (!account.imap) throw new Error(`Account "${account.id}" has no IMAP (reading) configured.`);
    return { account, imap: account.imap };
  }

  requireSmtp(id?: string): { account: Account; smtp: SmtpConfig } {
    const account = this.resolve(id);
    if (!account.smtp) throw new Error(`Account "${account.id}" has no SMTP (sending) configured.`);
    return { account, smtp: account.smtp };
  }

  some(pred: (a: Account) => boolean): boolean {
    return this.list.some(pred);
  }

  /** Short hint appended to tool descriptions so the model knows the valid ids. */
  hint(): string {
    const labels = this.list.map((a) => `${a.id} (${a.label})`).join(", ");
    return `account: one of ${labels}; default ${this.defaultId}.`;
  }
}

function num(v: unknown, fallback: number): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build the account list from the environment.
 * Preferred: MAIL_ACCOUNTS as a JSON array. Fallback (backwards-compatible):
 * a single account from the flat SMTP_* / IMAP_* variables.
 */
export function parseAccounts(env: NodeJS.ProcessEnv): Accounts {
  const raw = (env.MAIL_ACCOUNTS || "").trim();
  const list: Account[] = [];

  if (raw) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`MAIL_ACCOUNTS is not valid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed)) throw new Error("MAIL_ACCOUNTS must be a JSON array.");
    for (const a of parsed) {
      if (!a || !a.id) throw new Error("Each MAIL_ACCOUNTS entry needs an id.");
      const smtp = a.smtp
        ? {
            host: a.smtp.host,
            port: num(a.smtp.port, 587),
            secure: a.smtp.secure ?? a.smtp.port === 465,
            user: a.smtp.user,
            pass: a.smtp.pass,
            from: a.smtp.from || a.smtp.user,
          }
        : undefined;
      const imap = a.imap
        ? {
            host: a.imap.host,
            port: num(a.imap.port, 993),
            secure: a.imap.secure ?? true,
            user: a.imap.user || smtp?.user || "",
            pass: a.imap.pass || smtp?.pass || "",
          }
        : undefined;
      if (!smtp && !imap) continue;
      list.push({ id: String(a.id), label: a.label || a.id, imap, smtp });
    }
  } else {
    // Legacy single-account mode.
    const smtpHost = env.SMTP_HOST || "";
    const smtpUser = env.SMTP_USER || "";
    const smtpPass = env.SMTP_PASS || "";
    const imapHost = env.IMAP_HOST || "";
    const smtp =
      smtpHost && smtpUser && smtpPass
        ? {
            host: smtpHost,
            port: num(env.SMTP_PORT, 587),
            secure: env.SMTP_SECURE === "true",
            user: smtpUser,
            pass: smtpPass,
            from: env.SMTP_FROM || smtpUser,
          }
        : undefined;
    const imapUser = env.IMAP_USER || smtpUser;
    const imapPass = env.IMAP_PASS || smtpPass;
    const imap =
      imapHost && imapUser && imapPass
        ? {
            host: imapHost,
            port: num(env.IMAP_PORT, 993),
            secure: env.IMAP_SECURE ? env.IMAP_SECURE === "true" : true,
            user: imapUser,
            pass: imapPass,
          }
        : undefined;
    if (smtp || imap) {
      list.push({ id: "default", label: smtp?.from || imapUser || "default", imap, smtp });
    }
  }

  const defaultId = env.DEFAULT_MAIL_ACCOUNT && list.some((a) => a.id === env.DEFAULT_MAIL_ACCOUNT)
    ? env.DEFAULT_MAIL_ACCOUNT
    : list[0]?.id || "";
  return new Accounts(list, defaultId);
}
