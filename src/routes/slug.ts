import { Hono } from "hono";
import type { AppEnv } from "../middleware.js";
import { attachSession, requireAuth } from "../middleware.js";
import { prisma } from "../lib/prisma.js";
import { validateSlug } from "../lib/slug.js";

export const slugRoute = new Hono<AppEnv>();

slugRoute.use("*", attachSession, requireAuth);

slugRoute.get("/check", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const slug = c.req.query("slug");
	if (!slug) return c.json({ error: "missing_slug" }, 400);

	const validationError = validateSlug(slug);
	if (validationError) {
		return c.json({ available: false, reason: validationError });
	}

	const existing = await prisma.site.findUnique({ where: { slug }, select: { userId: true } });
	if (existing && existing.userId !== user.id) {
		return c.json({ available: false, reason: "taken" });
	}

	return c.json({ available: true, reason: null });
});
