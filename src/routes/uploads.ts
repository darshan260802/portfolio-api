import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../middleware.js";
import { attachSession, requireAuth } from "../middleware.js";
import { env } from "../env.js";
import { supabase } from "../lib/supabase.js";
import { toFieldErrors } from "../lib/zod-error.js";

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
	const log = c.get("log");

	const body = await c.req.json().catch(() => null);
	const parsed = requestSchema.safeParse(body);
	if (!parsed.success) {
		const { message, fields } = toFieldErrors(parsed.error);
		return c.json({ error: "invalid_body", message, fields }, 400);
	}

	const { kind, filename } = parsed.data;
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	const rule = ALLOWED_KINDS[kind];
	if (!rule.extensions.includes(ext as never)) {
		return c.json(
			{
				error: "unsupported_extension",
				allowed: rule.extensions,
				message: `That file type isn't supported. Allowed: ${rule.extensions.join(", ")}.`,
			},
			400,
		);
	}

	const path = `${user.id}/${kind}/${randomUUID()}.${ext}`;
	const { data, error } = await supabase.storage
		.from(env.SUPABASE_BUCKET)
		.createSignedUploadUrl(path);

	if (error || !data) {
		log?.error("failed to create signed upload URL", { userId: user.id, kind, path, err: error });
		return c.json({ error: "upload_url_failed", message: "Couldn't prepare the upload. Try again." }, 502);
	}

	const { data: publicUrlData } = supabase.storage.from(env.SUPABASE_BUCKET).getPublicUrl(path);

	log?.info("signed upload URL issued", { userId: user.id, kind, path });

	return c.json({
		path: data.path,
		token: data.token,
		signedUrl: data.signedUrl,
		publicUrl: publicUrlData.publicUrl,
		maxBytes: rule.maxBytes,
	});
});
