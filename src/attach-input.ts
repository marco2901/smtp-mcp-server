import { z } from "zod/v3";

// Attachment INPUT (for sending). Claude.ai can't hand a tool a raw binary blob
// reliably, so the primary path is a URL the server fetches; base64 works for
// small inline content.
export const attachmentInputSchema = z
  .array(
    z.object({
      filename: z.string().describe("Filename shown to the recipient"),
      url: z
        .string()
        .optional()
        .describe("HTTPS URL the server fetches and attaches (e.g. a Paperless or OneDrive share link)"),
      content_base64: z.string().optional().describe("Alternatively, the file content as base64"),
      content_type: z.string().optional().describe("MIME type, e.g. application/pdf (optional)"),
    })
  )
  .optional()
  .describe("Files to attach. Give each as a URL (preferred) or as base64.");

export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

export interface NodemailerAttachment {
  filename: string;
  href?: string;
  content?: string;
  encoding?: string;
  contentType?: string;
}

/** Map the tool input to nodemailer/MailComposer attachment objects (used for both send and draft). */
export function toNodemailerAttachments(
  input: AttachmentInput
): NodemailerAttachment[] | undefined {
  if (!input || !input.length) return undefined;
  return input.map((a) => {
    if (a.url) {
      return { filename: a.filename, href: a.url, contentType: a.content_type };
    }
    if (a.content_base64) {
      return {
        filename: a.filename,
        content: a.content_base64,
        encoding: "base64",
        contentType: a.content_type,
      };
    }
    throw new Error(`Attachment "${a.filename}" needs either a url or content_base64.`);
  });
}
