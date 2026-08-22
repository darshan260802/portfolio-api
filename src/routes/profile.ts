import { Hono } from "hono";
import { z } from "zod";
import { emptyPortfolioData, portfolioDataSchema } from "@pb/templates";
import type { AppEnv } from "../middleware.js";
import { attachSession, requireAuth } from "../middleware.js";
import { prisma } from "../lib/prisma.js";

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

	const body = await c.req.json().catch(() => null);
	const parsed = updateProfileSchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
	}

	const profile = await prisma.profile.upsert({
		where: { userId: user.id },
		create: {
			userId: user.id,
			data: parsed.data.data,
			templateId: parsed.data.templateId,
		},
		update: {
			data: parsed.data.data,
			...(parsed.data.templateId !== undefined ? { templateId: parsed.data.templateId } : {}),
		},
	});

	return c.json({ templateId: profile.templateId, data: profile.data });
});
