import { createHmac, randomUUID } from "node:crypto";
import { env } from "../env.js";
import { log } from "../lib/logger.js";

/**
 * Outbound notification webhook — the one place this API tells an external
 * system that something happened to a portfolio: a site was created, its
 * template or subdomain changed, or a publish went live / failed.
 *
 * Design rules, all of them deliberate:
 *
 *  - **Never blocks and never throws.** `notify()` returns synchronously
 *    and delivery happens on a floating promise. Publishing a portfolio
 *    must not get slower — or worse, fail — because a notification
 *    endpoint is down. Every failure ends up in the logs, nowhere else.
 *  - **No-op when unconfigured.** With NOTIFY_WEBHOOK_URL unset there is
 *    no HTTP call at all, so dev/test/self-hosted setups need no extra
 *    configuration.
 *  - **Signed.** When NOTIFY_WEBHOOK_SECRET is set, each delivery carries
 *    an HMAC-SHA256 over `${timestamp}.${body}` in `x-pb-signature`, so
 *    the receiver can reject anything it didn't send itself (and reject
 *    replays by checking `x-pb-timestamp`).
 *  - **Retried, but only where retrying can help.** Network errors,
 *    timeouts, 429 and 5xx get up to three attempts with a backoff; other
 *    4xx are a receiver-side decision (bad payload, revoked URL) and are
 *    not worth hammering.
 */

const hookLog = log.child("webhook");

export type WebhookEvent =
	/** A user claimed a subdomain — their portfolio exists for the first time. */
	| "site.created"
	/** The site's template was switched (a publish under a different design). */
	| "site.template_changed"
	/** The site's subdomain was renamed. */
	| "site.slug_changed"
	/** A build finished and the portfolio is live at its URL. */
	| "site.published"
	/** A build failed; nothing changed for visitors. */
	| "site.publish_failed"
	/** A user picked a different template in the wizard (before any publish). */
	| "profile.template_changed";

export interface WebhookDelivery {
	/** Unique per delivery — use it to make the receiver idempotent. */
	id: string;
	event: WebhookEvent;
	occurredAt: string;
	data: Record<string, unknown>;
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const USER_AGENT = "portfolio-builder-api-webhook/1";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `sha256=<hex>` over `${timestamp}.${body}`, or null when no secret is configured. */
function signBody(body: string, timestamp: string): string | null {
	if (!env.NOTIFY_WEBHOOK_SECRET) return null;
	const mac = createHmac("sha256", env.NOTIFY_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest("hex");
	return `sha256=${mac}`;
}

/** 429 and 5xx are worth another try; every other 4xx is the receiver's verdict. */
function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

async function deliver(url: string, delivery: WebhookDelivery): Promise<void> {
	const body = JSON.stringify(delivery);
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const signature = signBody(body, timestamp);

	const headers: Record<string, string> = {
		"content-type": "application/json",
		"user-agent": USER_AGENT,
		"x-pb-event": delivery.event,
		"x-pb-delivery": delivery.id,
		"x-pb-timestamp": timestamp,
	};
	if (signature) headers["x-pb-signature"] = signature;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const res = await fetch(url, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(env.NOTIFY_WEBHOOK_TIMEOUT_MS),
			});

			if (res.ok) {
				hookLog.info("delivered", { event: delivery.event, deliveryId: delivery.id, status: res.status, attempt });
				return;
			}

			const retryable = isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS;
			hookLog.error("delivery rejected", {
				event: delivery.event,
				deliveryId: delivery.id,
				status: res.status,
				attempt,
				willRetry: retryable,
			});
			if (!retryable) return;
		} catch (err) {
			// Network error, DNS failure or our own timeout — all transient
			// enough to be worth another attempt.
			const retryable = attempt < MAX_ATTEMPTS;
			hookLog.error("delivery failed", {
				event: delivery.event,
				deliveryId: delivery.id,
				attempt,
				willRetry: retryable,
				err,
			});
			if (!retryable) return;
		}

		await sleep(RETRY_BASE_DELAY_MS * attempt);
	}
}

/**
 * Fires one webhook for `event`. Returns immediately: delivery (and any
 * retrying) happens in the background, and a failure is logged, never
 * thrown at the caller. Safe to call from a request handler or from inside
 * the build queue.
 */
export function notify(event: WebhookEvent, data: Record<string, unknown>): void {
	const url = env.NOTIFY_WEBHOOK_URL;
	if (!url) {
		hookLog.debug("skipped (NOTIFY_WEBHOOK_URL not set)", { event });
		return;
	}

	const delivery: WebhookDelivery = {
		id: randomUUID(),
		event,
		occurredAt: new Date().toISOString(),
		data,
	};

	hookLog.debug("queued", { event, deliveryId: delivery.id });
	// deliver() already handles every failure it can see; this catch only
	// guards against a bug in the delivery path itself becoming an
	// unhandled rejection that takes down the process.
	void deliver(url, delivery).catch((err) => {
		hookLog.error("delivery threw (should have been handled)", { event, deliveryId: delivery.id, err });
	});
}
