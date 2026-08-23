import { Hono } from "hono";
import { z } from "zod";
import { emptyPortfolioData, portfolioDataSchema } from "@pb/templates";
import type { AppEnv } from "../middleware.js";
import { attachSession, requireAuth } from "../middleware.js";
import { prisma } from "../lib/prisma.js";
import { toFieldErrors } from "../lib/zod-error.js";
import { sanitizePortfolioData } from "../lib/rich-text.js";

export const profileRoute = new Hono<AppEnv>();

profileRoute.use("*", attachSession, requireAuth);

const updateProfileSchema = z.object({
	templateId: z.string().min(1).optional(),
	data: portfolioDataSchema,
});

profileRoute.get("/", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
	if (!profile) {
		return c.json({ templateId: null, data: emptyPortfolioData });
	}
	return c.json({ templateId: profile.templateId, data: profile.data });
});

profileRoute.put("/", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);
	const log = c.get("log");

	const body = await c.req.json().catch(() => null);
	const parsed = updateProfileSchema.safeParse(body);
	if (!parsed.success) {
		const { message, fields } = toFieldErrors(parsed.error);
		log?.warn("profile update rejected: invalid body", { userId: user.id, message, fields });
		return c.json({ error: "invalid_body", message, fields }, 400);
	}

	// The only write path for user-authored rich text (profile.bio,
	// experience.summary, project.description) — sanitize here so every
	// downstream reader (live preview, ZIP export, hosted build) can trust
	// what's already in the database without re-checking it.
	const sanitizedData = sanitizePortfolioData(parsed.data.data);

	const profile = await prisma.profile.upsert({
		where: { userId: user.id },
		create: {
			userId: user.id,
			data: sanitizedData,
			templateId: parsed.data.templateId,
		},
		update: {
			data: sanitizedData,
			...(parsed.data.templateId !== undefined ? { templateId: parsed.data.templateId } : {}),
		},
	});

	log?.info("profile updated", { userId: user.id, templateId: profile.templateId });
	return c.json({ templateId: profile.templateId, data: profile.data });
});
