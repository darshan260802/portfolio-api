import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../middleware.js";
import { attachSession, requireAuth } from "../middleware.js";
import { env } from "../env.js";
import { supabase } from "../lib/supabase.js";

export const uploadsRoute = new Hono<AppEnv>();

uploadsRoute.use("*", attachSession, requireAuth);

const ALLOWED_KINDS = {
	avatar: { extensions: ["png", "jpg", "jpeg", "webp"], maxBytes: 5 * 1024 * 1024 },
	projectImage: { extensions: ["png", "jpg", "jpeg", "webp", "gif"], maxBytes: 8 * 1024 * 1024 },
	resume: { extensions: ["pdf"], maxBytes: 10 * 1024 * 1024 },
} as const;

const requestSchema = z.object({
	kind: z.enum(["avatar", "projectImage", "resume"]),
	filename: z.string().min(1).max(200),
});

/**
 * Returns a Supabase Storage signed upload URL scoped to the current user.
 * The browser PUTs the file directly to Supabase with this URL — the file
 * never passes through the API. `localizeAssets` downloads whatever ends
 * up referenced in the user's PortfolioData at export/deploy time, so the
 * generated project stays self-contained regardless of storage layout.
 */
uploadsRoute.post("/", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const body = await c.req.json().catch(() => null);
	const parsed = requestSchema.safeParse(body);
	if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

	const { kind, filename } = parsed.data;
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	const rule = ALLOWED_KINDS[kind];
	if (!rule.extensions.includes(ext as never)) {
		return c.json({ error: "unsupported_extension", allowed: rule.extensions }, 400);
	}

	const path = `${user.id}/${kind}/${randomUUID()}.${ext}`;
	const { data, error } = await supabase.storage
		.from(env.SUPABASE_BUCKET)
		.createSignedUploadUrl(path);

	if (error || !data) {
		console.error("[uploads] failed to create signed upload URL:", error);
		return c.json({ error: "upload_url_failed" }, 502);
	}

	const { data: publicUrlData } = supabase.storage.from(env.SUPABASE_BUCKET).getPublicUrl(path);

	return c.json({
		path: data.path,
		token: data.token,
		signedUrl: data.signedUrl,
		publicUrl: publicUrlData.publicUrl,
		maxBytes: rule.maxBytes,
	});
});
