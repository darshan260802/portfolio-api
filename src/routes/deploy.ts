import { Hono } from "hono";
import { z } from "zod";
import { getTemplateManifest } from "@pb/templates";
import type { AppEnv } from "../middleware.js";
import { attachSession, requireAuth } from "../middleware.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../env.js";
import { validateSlug } from "../lib/slug.js";
import { toFieldErrors } from "../lib/zod-error.js";
import { buildQueue } from "../services/queue.service.js";
import { runDeployment } from "../services/builder.service.js";
import { pointNewSlugAtExisting, unpublishSlug } from "../services/hosting.service.js";

export const deployRoute = new Hono<AppEnv>();

deployRoute.use("*", attachSession, requireAuth);

const deployBodySchema = z.object({
	slug: z.string().optional(),
	templateId: z.string().min(1).optional(),
});

deployRoute.get("/me/site", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const site = await prisma.site.findUnique({ where: { userId: user.id } });
	if (!site) return c.json({ site: null });

	return c.json({
		site: {
			slug: site.slug,
			templateId: site.templateId,
			status: site.status,
			url: site.status === "LIVE" ? `https://${site.slug}.${env.PORTFOLIO_DOMAIN}` : null,
		},
	});
});

deployRoute.post("/deploy", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);
	const log = c.get("log");

	const body = await c.req.json().catch(() => ({}));
	const parsed = deployBodySchema.safeParse(body);
	if (!parsed.success) {
		const { message, fields } = toFieldErrors(parsed.error);
		return c.json({ error: "invalid_body", message, fields }, 400);
	}

	const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
	if (!profile) {
		return c.json({ error: "no_profile", message: "Fill in your portfolio details first." }, 400);
	}

	let site = await prisma.site.findUnique({ where: { userId: user.id } });

	if (!site) {
		const slug = parsed.data.slug;
		if (!slug) return c.json({ error: "slug_required", message: "Choose a subdomain first." }, 400);

		const validationError = validateSlug(slug);
		if (validationError) {
			return c.json(
				{ error: "invalid_slug", reason: validationError, message: slugErrorMessage(validationError) },
				400,
			);
		}

		const templateId = parsed.data.templateId ?? profile.templateId;
		if (!templateId) return c.json({ error: "no_template", message: "Choose a template first." }, 400);
		if (!getTemplateManifest(templateId)) {
			return c.json({ error: "unknown_template", message: "Unknown template." }, 400);
		}

		try {
			site = await prisma.site.create({
				data: { userId: user.id, slug, templateId, status: "DRAFT" },
			});
		} catch (err) {
			if (isUniqueConstraintError(err)) {
				return c.json({ error: "invalid_slug", reason: "taken", message: slugErrorMessage("taken") }, 409);
			}
			throw err;
		}
	} else if (parsed.data.templateId && parsed.data.templateId !== site.templateId) {
		if (!getTemplateManifest(parsed.data.templateId)) {
			return c.json({ error: "unknown_template", message: "Unknown template." }, 400);
		}
		site = await prisma.site.update({
			where: { id: site.id },
			data: { templateId: parsed.data.templateId },
		});
	}

	const deployment = await prisma.deployment.create({
		data: { siteId: site.id, status: "QUEUED" },
	});

	log?.info("deployment queued", {
		userId: user.id,
		deploymentId: deployment.id,
		siteId: site.id,
		slug: site.slug,
		templateId: site.templateId,
		queueStats: buildQueue.stats,
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
	const log = c.get("log");

	const body = await c.req.json().catch(() => null);
	const parsed = renameSlugSchema.safeParse(body);
	if (!parsed.success) {
		const { message, fields } = toFieldErrors(parsed.error);
		return c.json({ error: "invalid_body", message, fields }, 400);
	}

	const newSlug = parsed.data.slug;
	const validationError = validateSlug(newSlug);
	if (validationError) {
		return c.json(
			{ error: "invalid_slug", reason: validationError, message: slugErrorMessage(validationError) },
			400,
		);
	}

	const site = await prisma.site.findUnique({ where: { userId: user.id } });
	if (!site) return c.json({ error: "no_site", message: "You don't have a portfolio yet." }, 400);
	if (site.slug === newSlug) return c.json({ slug: site.slug });

	// Not live yet (nothing published): a plain DB rename, no filesystem
	// involved.
	if (site.status !== "LIVE") {
		try {
			const updated = await prisma.site.update({ where: { id: site.id }, data: { slug: newSlug } });
			log?.info("slug renamed (draft, no publish)", { userId: user.id, from: site.slug, to: newSlug });
			return c.json({ slug: updated.slug });
		} catch (err) {
			if (isUniqueConstraintError(err)) {
				return c.json({ error: "invalid_slug", reason: "taken", message: slugErrorMessage("taken") }, 409);
			}
			throw err;
		}
	}

	// Live: point the new slug at the same release before touching the DB,
	// so there is never a moment neither slug resolves. See the design
	// doc's "Resolved implementation mechanics" #7.
	const oldSlug = site.slug;
	log?.info("slug rename (live): pointing new slug at existing release", { userId: user.id, oldSlug, newSlug });
	const { url } = pointNewSlugAtExisting(oldSlug, newSlug);
	await verifySlugServes(url, log);

	try {
		const updated = await prisma.site.update({ where: { id: site.id }, data: { slug: newSlug } });
		unpublishSlug(oldSlug);
		log?.info("slug rename (live) committed", { userId: user.id, oldSlug, newSlug, url });
		return c.json({ slug: updated.slug, url });
	} catch (err) {
		unpublishSlug(newSlug); // roll back the filesystem-only step
		log?.error("slug rename (live) failed after DB error — rolled back filesystem step", {
			userId: user.id,
			oldSlug,
			newSlug,
			err,
		});
		if (isUniqueConstraintError(err)) {
			return c.json({ error: "invalid_slug", reason: "taken", message: slugErrorMessage("taken") }, 409);
		}
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
async function verifySlugServes(url: string, log: AppEnv["Variables"]["log"] | undefined): Promise<void> {
	try {
		const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
		if (!res.ok) log?.warn("slug verify: unexpected status", { url, status: res.status });
	} catch (err) {
		log?.warn("slug verify: unreachable", { url, err });
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

function slugErrorMessage(reason: string): string {
	switch (reason) {
		case "taken":
			return "That subdomain is already taken.";
		case "reserved":
			return "That subdomain is reserved and can't be used.";
		case "too_short":
			return "Subdomain must be at least 3 characters.";
		case "too_long":
			return "Subdomain must be 63 characters or fewer.";
		case "invalid_format":
			return "Subdomain can only contain lowercase letters, numbers, and hyphens (not at the start or end).";
		case "punycode_like":
			return "Subdomain can't use that character pattern.";
		default:
			return "That subdomain isn't valid.";
	}
}
