import { and, asc, eq, lt, sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import { emailOutbox, type Db, type DbOrTx } from '@episoft/db';
import type { Config } from '../config';

// E-mail outbox (§4.16): e-mails are written in the business transaction, then sent
// by a background loop with retries. pg-boss (spec §7.2) can replace the loop in a later lot.

export interface EmailAttachment {
  filename: string;
  contentType: string;
  /** Base64, stored as is in the outbox. */
  contentBase64: string;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

export async function queueEmail(db: DbOrTx, email: OutgoingEmail): Promise<void> {
  await db.insert(emailOutbox).values({ ...email, attachments: email.attachments ?? null });
}

export function pdfAttachment(filename: string, pdf: Buffer): EmailAttachment {
  return { filename, contentType: 'application/pdf', contentBase64: pdf.toString('base64') };
}

const MAX_ATTEMPTS = 5;

export function startMailer(db: Db, config: Config, log: FastifyBaseLogger): () => void {
  const transport = config.SMTP_HOST
    ? nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_PORT === 465,
        auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
      })
    : null;

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await db.transaction(async (tx) => {
        const batch = await tx
          .select()
          .from(emailOutbox)
          .where(and(eq(emailOutbox.status, 'PENDING'), lt(emailOutbox.attempts, MAX_ATTEMPTS)))
          .orderBy(asc(emailOutbox.createdAt))
          .limit(10)
          .for('update', { skipLocked: true });
        for (const mail of batch) {
          if (!transport) {
            // Without SMTP: in development, log the e-mail and mark it handled; otherwise keep it pending.
            if (config.NODE_ENV === 'development') {
              log.info(
                { to: mail.to, subject: mail.subject, text: mail.text },
                'e-mail (pas de SMTP)',
              );
              await tx
                .update(emailOutbox)
                .set({
                  status: 'SENT',
                  sentAt: new Date(),
                  lastError: 'journalisé, SMTP non configuré',
                })
                .where(eq(emailOutbox.id, mail.id));
            }
            continue;
          }
          try {
            await transport.sendMail({
              from: config.SMTP_FROM,
              to: mail.to,
              subject: mail.subject,
              html: mail.html,
              text: mail.text ?? undefined,
              attachments: ((mail.attachments as EmailAttachment[] | null) ?? []).map((a) => ({
                filename: a.filename,
                contentType: a.contentType,
                content: Buffer.from(a.contentBase64, 'base64'),
              })),
            });
            await tx
              .update(emailOutbox)
              .set({
                status: 'SENT',
                sentAt: new Date(),
                attempts: sql`${emailOutbox.attempts} + 1`,
              })
              .where(eq(emailOutbox.id, mail.id));
          } catch (e) {
            const attempts = mail.attempts + 1;
            await tx
              .update(emailOutbox)
              .set({
                attempts,
                lastError: String(e),
                status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
              })
              .where(eq(emailOutbox.id, mail.id));
            log.warn({ err: e, id: mail.id }, 'échec d’envoi de courriel');
          }
        }
      });
    } catch (e) {
      log.error({ err: e }, 'file d’envoi des courriels');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, 15_000);
  void tick();
  return () => clearInterval(timer);
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
