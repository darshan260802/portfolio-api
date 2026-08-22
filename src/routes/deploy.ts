import { Hono } from "hono";
import { z } from "zod";
import { getTemplateManifest } from "@pb/templates";
import type { AppEnv } from "../middleware.js";
import { attachSession, requireAuth } from "../middleware.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../env.js";
import { validateSlug } from "../lib/slug.js";
import { buildQueue } from "../services/queue.service.js";
import { runDeployment } from "../services/builder.service.js";
import { pointNewSlugAtExisting, unpublishSlug } from "../services/hosting.service.js";

export const deployRoute = new Hono<AppEnv>();

deployRoute.use("*", attachSession, requireAuth);

const deployBodySchema = z.object({
	slug: z.string().optional(),
	templateId: z.string().min(1).optional(),
});

deployRoute.post("/deploy", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const body = await c.req.json().catch(() => ({}));
	const parsed = deployBodySchema.safeParse(body);
	if (!parsed.success) {
		return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
	}

	const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
	if (!profile) {
		return c.json({ error: "no_profile", message: "Fill in your portfolio details first." }, 400);
	}

	let site = await prisma.site.findUnique({ where: { userId: user.id } });

	if (!site) {
		const slug = parsed.data.slug;
		if (!slug) return c.json({ error: "slug_required" }, 400);

		const validationError = validateSlug(slug);
		if (validationError) return c.json({ error: "invalid_slug", reason: validationError }, 400);

		const templateId = parsed.data.templateId ?? profile.templateId;
		if (!templateId) return c.json({ error: "no_template" }, 400);
		if (!getTemplateManifest(templateId)) return c.json({ error: "unknown_template" }, 400);

		try {
			site = await prisma.site.create({
				data: { userId: user.id, slug, templateId, status: "DRAFT" },
			});
		} catch (err) {
			if (isUniqueConstraintError(err)) {
				return c.json({ error: "invalid_slug", reason: "taken" }, 409);
			}
			throw err;
		}
	} else if (parsed.data.templateId && parsed.data.templateId !== site.templateId) {
		if (!getTemplateManifest(parsed.data.templateId)) {
			return c.json({ error: "unknown_template" }, 400);
		}
		site = await prisma.site.update({
			where: { id: site.id },
			data: { templateId: parsed.data.templateId },
		});
	}

	const deployment = await prisma.deployment.create({
		data: { siteId: site.id, status: "QUEUED" },
	});

	buildQueue.push(() => runDeployment(deployment.id));

	return c.json({ deploymentId: deployment.id }, 202);
});

deployRoute.get("/deployments/:id", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const deployment = await prisma.deployment.findUnique({
		where: { id: c.req.param("id") },
		include: { site: true },
	});
	if (!deployment || deployment.site.userId !== user.id) {
		return c.json({ error: "not_found" }, 404);
	}

	return c.json({
		id: deployment.id,
		status: deployment.status,
		log: deployment.log,
		startedAt: deployment.startedAt,
		finishedAt: deployment.finishedAt,
		url: deployment.status === "LIVE" ? `https://${deployment.site.slug}.${env.PORTFOLIO_DOMAIN}/` : null,
	});
});

const renameSlugSchema = z.object({ slug: z.string().min(1) });

deployRoute.patch("/me/site/slug", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const body = await c.req.json().catch(() => null);
	const parsed = renameSlugSchema.safeParse(body);
	if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

	const newSlug = parsed.data.slug;
	const validationError = validateSlug(newSlug);
	if (validationError) return c.json({ error: "invalid_slug", reason: validationError }, 400);

	const site = await prisma.site.findUnique({ where: { userId: user.id } });
	if (!site) return c.json({ error: "no_site" }, 400);
	if (site.slug === newSlug) return c.json({ slug: site.slug });

	// Not live yet (nothing published): a plain DB rename, no filesystem
	// involved.
	if (site.status !== "LIVE") {
		try {
			const updated = await prisma.site.update({ where: { id: site.id }, data: { slug: newSlug } });
			return c.json({ slug: updated.slug });
		} catch (err) {
			if (isUniqueConstraintError(err)) return c.json({ error: "invalid_slug", reason: "taken" }, 409);
			throw err;
		}
	}

	// Live: point the new slug at the same release before touching the DB,
	// so there is never a moment neither slug resolves. See the design
	// doc's "Resolved implementation mechanics" #7.
	const oldSlug = site.slug;
	const { url } = pointNewSlugAtExisting(oldSlug, newSlug);
	await verifySlugServes(url);

	try {
		const updated = await prisma.site.update({ where: { id: site.id }, data: { slug: newSlug } });
		unpublishSlug(oldSlug);
		return c.json({ slug: updated.slug, url });
	} catch (err) {
		unpublishSlug(newSlug); // roll back the filesystem-only step
		if (isUniqueConstraintError(err)) return c.json({ error: "invalid_slug", reason: "taken" }, 409);
		throw err;
	}
});

/**
 * Best-effort sanity check that nginx actually serves through the new
 * symlink before we commit the DB rename. Non-fatal on failure (DNS
 * propagation, local/dev environments without real subdomain routing) —
 * the atomic filesystem symlink is the real guarantee; this just catches
 * an obviously broken nginx config early.
 */
async function verifySlugServes(url: string): Promise<void> {
	try {
		const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
		if (!res.ok) console.warn(`[deploy] slug verify: ${url} responded ${res.status}`);
	} catch (err) {
		console.warn(`[deploy] slug verify: could not reach ${url}: ${(err as Error).message}`);
	}
}

function isUniqueConstraintError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code: unknown }).code === "P2002"
	);
}
