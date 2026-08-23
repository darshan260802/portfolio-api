import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { getTemplateManifest, portfolioDataSchema } from "@pb/templates";
import type { AppEnv } from "../middleware.js";
import { attachSession, requireAuth } from "../middleware.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../env.js";
import { toFieldErrors } from "../lib/zod-error.js";
import { materializeProject } from "../services/scaffold.service.js";
import { localizeAssets } from "../services/assets.service.js";
import { zipDirectoryToBuffer } from "../services/zip.service.js";

export const exportRoute = new Hono<AppEnv>();

exportRoute.use("*", attachSession, requireAuth);

const exportBodySchema = z.object({
	templateId: z.string().min(1).optional(),
});

exportRoute.post("/zip", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);
	const log = c.get("log");

	const body = await c.req.json().catch(() => ({}));
	const parsed = exportBodySchema.safeParse(body);
	if (!parsed.success) {
		const { message, fields } = toFieldErrors(parsed.error);
		return c.json({ error: "invalid_body", message, fields }, 400);
	}

	const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
	if (!profile) {
		return c.json({ error: "no_profile", message: "Fill in your portfolio details first." }, 400);
	}

	const templateId = parsed.data.templateId ?? profile.templateId;
	if (!templateId) {
		return c.json({ error: "no_template", message: "Choose a template first." }, 400);
	}
	const manifest = getTemplateManifest(templateId);
	if (!manifest) {
		return c.json({ error: "unknown_template", message: "Unknown template." }, 400);
	}

	// Re-validate on read: cheap insurance against stale rows from before a
	// schema change, and gives us a properly typed PortfolioData for free.
	const data = portfolioDataSchema.parse(profile.data);
	const projectName = slugifyProjectName(data.profile.fullName || "portfolio");

	const tmpDir = mkdtempSync(join(env.BUILD_TMP_DIR, "export-"));
	log?.info("export started", { userId: user.id, templateId, projectName });
	try {
		const localized = await localizeAssets(data, tmpDir);
		materializeProject({
			targetDir: tmpDir,
			templateId,
			data: localized,
			projectName,
			siteTitle: data.seo?.title || data.profile.fullName || "My Portfolio",
			siteDescription: data.seo?.description || data.profile.headline || "",
			// No live URL yet for a plain ZIP export — the README explains how
			// to fill this in for the user's own deployment.
			siteUrl: "",
			siteOgImage: data.seo?.ogImageUrl ?? localized.profile.avatarUrl ?? "",
		});

		const zipBuffer = await zipDirectoryToBuffer(tmpDir);
		log?.info("export completed", { userId: user.id, templateId, projectName, bytes: zipBuffer.length });

		c.header("Content-Type", "application/zip");
		c.header("Content-Disposition", `attachment; filename="${projectName}.zip"`);
		return c.body(new Uint8Array(zipBuffer));
	} catch (err) {
		log?.error("export failed", { userId: user.id, templateId, projectName, err });
		throw err;
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

function slugifyProjectName(name: string): string {
	const slug = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "portfolio";
}
