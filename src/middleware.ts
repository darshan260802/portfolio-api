import type { Context, Next } from "hono";
import { auth } from "./lib/auth.js";
import { log, type Logger } from "./lib/logger.js";

export type AuthUser = (typeof auth.$Infer.Session)["user"];

export interface AppEnv {
	Variables: {
		user: AuthUser | null;
		requestId: string;
		log: Logger;
	};
}

/**
 * Mints a per-request id and a scoped logger, and logs start/finish with
 * status + duration. Mounted first (before CORS) so every request is
 * observed even if it fails a later middleware. This is the backbone of
 * "logs in all backend operations" — c.get("log") in any route/service
 * downstream carries the requestId automatically.
 */
export async function requestLogger(c: Context<AppEnv>, next: Next) {
	const requestId = crypto.randomUUID();
	const reqLog = log.child("http", { requestId });
	c.set("requestId", requestId);
	c.set("log", reqLog);

	const start = performance.now();
	const { method } = c.req;
	const path = c.req.path;
	reqLog.info("request start", { method, path });

	await next();

	const durationMs = Math.round(performance.now() - start);
	const user = c.get("user");
	reqLog.info("request done", {
		method,
		path,
		status: c.res.status,
		durationMs,
		userId: user?.id ?? null,
	});
}

/** Attaches the current session's user (or null) to context on every request. */
export async function attachSession(c: Context<AppEnv>, next: Next) {
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	c.set("user", session?.user ?? null);
	await next();
}

/** Use after attachSession on any route that requires a signed-in user. */
export async function requireAuth(c: Context<AppEnv>, next: Next) {
	if (!c.get("user")) {
		return c.json({ error: "unauthorized" }, 401);
	}
	await next();
}
