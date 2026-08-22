import type { Context, Next } from "hono";
import { auth } from "./lib/auth.js";

export type AuthUser = (typeof auth.$Infer.Session)["user"];

export interface AppEnv {
	Variables: {
		user: AuthUser | null;
	};
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
