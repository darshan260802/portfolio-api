import { Resend } from "resend";
import { env } from "../env.js";
import { log } from "./logger.js";

/**
 * Wraps the Resend SDK so nothing else in this codebase talks to it
 * directly. This exists because of a real production incident: Better
 * Auth's `sendResetPassword` / `sendVerificationEmail` callbacks called
 * `resend.emails.send()` and ignored the result. The Resend SDK does NOT
 * throw on a failed send — it resolves with `{ data: null, error }` — so
 * every failure (bad from-address, unverified domain, rate limit, …) was
 * silently swallowed and the caller (Better Auth, then the signup/reset
 * UI) believed the email had gone out. `sendMail` below inspects `error`
 * and throws, and logs every attempt, so a failure is visible in
 * production logs *and* propagates back to the client as a real error.
 */

const mailLog = log.child("mail");
const resend = new Resend(env.RESEND_API_KEY);

export class MailError extends Error {
	/** Resend's own error code, e.g. "invalid_from_address", "rate_limit_exceeded". */
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "MailError";
		this.code = code;
	}
}

/**
 * Resend's from-address parser wants "Display Name <email@domain>" with a
 * space before "<". A value like "Display Name<email@domain>" has, in the
 * past, been rejected with invalid_from_address — normalize defensively so
 * a config typo like that can't silently break every outbound email again.
 */
export function normalizeFrom(from: string): string {
	return from.replace(/^([^<>]+?)\s*<(.+)>$/, (_match, name: string, addr: string) => `${name.trim()} <${addr}>`);
}

const RETRYABLE_CODES = new Set(["rate_limit_exceeded", "internal_server_error", "application_error"]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SendMailInput {
	to: string;
	subject: string;
	html: string;
}

/**
 * Sends one email. Throws MailError on any failure Resend reports (after
 * exhausting retries for transient codes) — callers must not swallow this;
 * letting it propagate is what makes a broken sender visible instead of a
 * silent no-op.
 */
export async function sendMail({ to, subject, html }: SendMailInput): Promise<void> {
	const from = normalizeFrom(env.EMAIL_FROM);

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		mailLog.info("sending", { to, subject, from, attempt });

		const { data, error } = await resend.emails.send({ from, to, subject, html });

		if (!error) {
			mailLog.info("sent", { to, subject, messageId: data?.id, attempt });
			return;
		}

		const retryable = RETRYABLE_CODES.has(error.name) && attempt < MAX_ATTEMPTS;
		mailLog.error("failed", {
			to,
			subject,
			from,
			attempt,
			code: error.name,
			message: error.message,
			willRetry: retryable,
		});

		if (!retryable) {
			throw new MailError(error.name, error.message);
		}

		await sleep(RETRY_BASE_DELAY_MS * attempt);
	}
}
