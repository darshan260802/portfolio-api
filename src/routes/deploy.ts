import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { getTemplateManifest } from "@pb/templates";
import type { Site } from "../../generated/prisma/client.js";
import type { AppEnv, AuthUser } from "../middleware.js";
import { attachSession, requireAuth } from "../middleware.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../env.js";
import { validateSlug } from "../lib/slug.js";
import { toFieldErrors } from "../lib/zod-error.js";
import { gitSourceSchema } from "../lib/git-source.js";
import { buildQueue } from "../services/queue.service.js";
import { runDeployment } from "../services/builder.service.js";
import { pointNewSlugAtExisting, unpublishSlug } from "../services/hosting.service.js";
import { notify } from "../services/webhook.service.js";
import { MissingEnvValuesError, readGitSource, saveGitSource } from "../services/site-source.service.js";

export const deployRoute = new Hono<AppEnv>();

deployRoute.use("*", attachSession, requireAuth);

const deployBodySchema = z.object({
	slug: z.string().optional(),
	templateId: z.string().min(1).optional(),
	// "TEMPLATE" | "GIT". Omitted means "whatever this site already is",
	// which is what makes the existing one-argument redeploys from Settings
	// (`{ slug }`, `{ templateId }`) keep working untouched.
	source: z.enum(["TEMPLATE", "GIT"]).optional(),
	// Inline config, so "import a repo and publish it" is one request from a
	// fresh account. Equivalent to PUT /me/site/git followed by this deploy.
	git: gitSourceSchema.optional(),
});

deployRoute.get("/me/site", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const site = await prisma.site.findUnique({ where: { userId: user.id } });
	if (!site) return c.json({ site: null });

	return c.json({ site: await siteResponse(site) });
});

/**
 * Saves (or replaces) the "host my own repository" config without building.
 *
 * Separate from POST /deploy because editing the config and publishing it
 * are genuinely different actions: someone rotating an API key in Settings
 * shouldn't be forced into a rebuild to save it, and someone who wants both
 * gets it in the deploy body instead.
 */
deployRoute.put("/me/site/git", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);
	const log = c.get("log");

	const body = await c.req.json().catch(() => null);
	const parsed = gitSourceSchema.extend({ slug: z.string().optional() }).safeParse(body);
	if (!parsed.success) {
		const { message, fields } = toFieldErrors(parsed.error);
		return c.json({ error: "invalid_body", message, fields }, 400);
	}

	const claimed = await claimSite({
		user,
		userId: user.id,
		slug: parsed.data.slug,
		templateId: null,
		source: "GIT",
	});
	if (!claimed.ok) return c.json(claimed.body, claimed.status);

	try {
		await saveGitSource(claimed.site.id, parsed.data);
	} catch (err) {
		if (err instanceof MissingEnvValuesError) return missingEnvValuesResponse(c, err);
		throw err;
	}

	const site = await prisma.site.findUniqueOrThrow({ where: { id: claimed.site.id } });
	log?.info("git source updated", { userId: user.id, siteId: site.id, repoUrl: parsed.data.repoUrl });
	return c.json({ site: await siteResponse(site) });
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

	const existing = await prisma.site.findUnique({ where: { userId: user.id } });
	// Precedence, most explicit first: a stated `source`; a `git` config,
	// which can only mean GIT; a named `templateId`, which is how Settings
	// switches a repo-backed site back to a template; then whatever the site
	// already is. That last fallback is what makes a bare redeploy
	// (`{ slug }`, from the appearance toggle) rebuild the current source
	// instead of silently reverting a repo-backed site to a template.
	const source =
		parsed.data.source ??
		(parsed.data.git ? "GIT" : undefined) ??
		(parsed.data.templateId ? "TEMPLATE" : undefined) ??
		existing?.source ??
		"TEMPLATE";

	// A template build renders the account's profile, so it needs one. A
	// repo build's content is the repository — requiring the wizard to be
	// filled in first would be asking for data nothing reads.
	let templateId: string | null = null;
	if (source === "TEMPLATE") {
		const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
		if (!profile) {
			return c.json({ error: "no_profile", message: "Fill in your portfolio details first." }, 400);
		}

		templateId = parsed.data.templateId ?? existing?.templateId ?? profile.templateId;
		if (!templateId) return c.json({ error: "no_template", message: "Choose a template first." }, 400);
		if (!getTemplateManifest(templateId)) {
			return c.json({ error: "unknown_template", message: "Unknown template." }, 400);
		}
	}

	const claimed = await claimSite({ user, userId: user.id, slug: parsed.data.slug, templateId, source });
	if (!claimed.ok) return c.json(claimed.body, claimed.status);
	let site = claimed.site;

	if (source === "GIT") {
		if (parsed.data.git) {
			try {
				await saveGitSource(site.id, parsed.data.git);
			} catch (err) {
				if (err instanceof MissingEnvValuesError) return missingEnvValuesResponse(c, err);
				throw err;
			}
			site = await prisma.site.findUniqueOrThrow({ where: { id: site.id } });
		} else if (!site.gitRepoUrl) {
			return c.json(
				{ error: "no_repository", message: "Add your repository details before publishing." },
				400,
			);
		} else if (site.source !== "GIT") {
			// Config already on file from an earlier import — switching back to
			// it shouldn't require re-entering the whole form.
			site = await prisma.site.update({ where: { id: site.id }, data: { source: "GIT" } });
		}
	} else if (site.source !== "TEMPLATE" || site.templateId !== templateId) {
		// Picking a template is also how you switch *away* from your own repo.
		// The git config stays on the row so switching back is one click.
		const previousTemplateId = site.templateId;
		site = await prisma.site.update({
			where: { id: site.id },
			data: { source: "TEMPLATE", templateId },
		});
		notify("site.template_changed", {
			siteId: site.id,
			slug: site.slug,
			templateId: site.templateId,
			previousTemplateId,
			user: { id: user.id, email: user.email, name: user.name },
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
		source: site.source,
		templateId: site.templateId,
		repoUrl: site.gitRepoUrl,
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
			notify("site.slug_changed", {
				siteId: site.id,
				slug: updated.slug,
				previousSlug: site.slug,
				templateId: site.templateId,
				live: false,
				url: null,
				user: { id: user.id, email: user.email, name: user.name },
			});
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
		notify("site.slug_changed", {
			siteId: site.id,
			slug: updated.slug,
			previousSlug: oldSlug,
			templateId: site.templateId,
			live: true,
			url,
			user: { id: user.id, email: user.email, name: user.name },
		});
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

/** The site shape every endpoint here reports — one place, so they can't drift. */
async function siteResponse(site: Site) {
	return {
		slug: site.slug,
		source: site.source,
		templateId: site.templateId,
		status: site.status,
		url: site.status === "LIVE" ? `https://${site.slug}.${env.PORTFOLIO_DOMAIN}` : null,
		// Reported even for a TEMPLATE site when config is on file, so
		// Settings can offer "switch back to your repo" without a second
		// round trip. `envKeys` only — values never leave the database.
		git: await readGitSource(site),
	};
}

type ClaimedSite =
	| { ok: true; site: Site }
	| { ok: false; status: 400 | 409; body: Record<string, unknown> };

/**
 * Resolves the account's single site, creating it on first publish.
 *
 * Both "publish" endpoints need exactly this — find it, or claim a
 * subdomain for it — and both need the same refusal when the request names
 * a *different* subdomain than the one the account already owns. An account
 * hosts one portfolio (Site.userId is unique), so that request can only be
 * answered by overwriting something else; say so instead. Renaming is
 * PATCH /me/site/slug.
 */
async function claimSite(opts: {
	user: AuthUser;
	userId: string;
	slug: string | undefined;
	templateId: string | null;
	source: "TEMPLATE" | "GIT";
}): Promise<ClaimedSite> {
	const existing = await prisma.site.findUnique({ where: { userId: opts.userId } });

	if (existing) {
		if (opts.slug && opts.slug !== existing.slug) {
			return {
				ok: false,
				status: 409,
				body: {
					error: "site_exists",
					slug: existing.slug,
					message:
						`Your account already hosts a portfolio at "${existing.slug}". You can only have one — ` +
						`publish over it, or rename it in Settings first.`,
				},
			};
		}
		return { ok: true, site: existing };
	}

	const slug = opts.slug;
	if (!slug) {
		return { ok: false, status: 400, body: { error: "slug_required", message: "Choose a subdomain first." } };
	}

	const validationError = validateSlug(slug);
	if (validationError) {
		return {
			ok: false,
			status: 400,
			body: { error: "invalid_slug", reason: validationError, message: slugErrorMessage(validationError) },
		};
	}

	try {
		const site = await prisma.site.create({
			data: { userId: opts.userId, slug, templateId: opts.templateId, source: opts.source, status: "DRAFT" },
		});
		notify("site.created", { siteId: site.id, slug: site.slug, templateId: site.templateId, source: site.source,
			user: { id: opts.user.id, email: opts.user.email, name: opts.user.name } });
		return { ok: true, site };
	} catch (err) {
		// The unique index on slug is what actually settles a race between two
		// accounts claiming the same subdomain; validateSlug above is only the
		// fast, friendly layer.
		if (isUniqueConstraintError(err)) {
			return {
				ok: false,
				status: 409,
				body: { error: "invalid_slug", reason: "taken", message: slugErrorMessage("taken") },
			};
		}
		throw err;
	}
}

function missingEnvValuesResponse(c: Context<AppEnv>, err: MissingEnvValuesError) {
	return c.json(
		{
			error: "missing_env_values",
			keys: err.keys,
			message:
				`No saved value for ${err.keys.join(", ")}. Your environment variables changed since this ` +
				`form was opened — re-enter the value and save again.`,
		},
		400,
	);
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
