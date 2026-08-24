import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { UPLOAD_RULES, isUploadKind, uploadFormatList } from "@pb/templates";
import type { AppEnv } from "../middleware.js";
import { attachSession, requireAuth } from "../middleware.js";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { supabase } from "../lib/supabase.js";
import { toFieldErrors } from "../lib/zod-error.js";
import { objectPathFromUrl, pruneUploads, storeUpload } from "../services/uploads.service.js";

export const uploadsRoute = new Hono<AppEnv>();

uploadsRoute.use("*", attachSession, requireAuth);

/* ------------------------------------------------------------------ */
/* Signed-URL uploads — project images                                 */
/* ------------------------------------------------------------------ */

/**
 * Only `projectImage` is left here. Avatars and résumés moved to the
 * validated multipart endpoint below: a signed upload URL carries no size or
 * type constraint of its own, so leaving a second, unchecked door onto the
 * same storage prefix would have made that endpoint's enforcement decorative.
 * Project images have no upload UI yet and are many-per-portfolio, which is
 * what this path is good at — it's kept as-is rather than changed blind.
 */
const ALLOWED_KINDS = {
	projectImage: { extensions: ["png", "jpg", "jpeg", "webp", "gif"], maxBytes: 8 * 1024 * 1024 },
} as const;

const requestSchema = z.object({
	kind: z.enum(["projectImage"]),
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

/* ------------------------------------------------------------------ */
/* Validated multipart uploads — profile photo and résumé              */
/* ------------------------------------------------------------------ */

/**
 * A multipart body is the file plus boundary framing, so Content-Length is
 * always a little larger than the file itself. This slack keeps a request
 * that is legitimately at the size limit from being turned away by the cheap
 * pre-read check; the real check happens against `file.size` afterwards.
 */
const MULTIPART_OVERHEAD_BYTES = 16 * 1024;

/**
 * Accepts one file, validates it against the shared rules for that kind
 * (`@pb/templates`'s `UPLOAD_RULES` — the same object the wizard's picker
 * uses), stores it, and returns what the client should write into
 * PortfolioData.
 *
 * Deliberately proxied through the API rather than handed a signed URL: the
 * 5 MB cap and "PDF/DOCX or JPEG/PNG/WebP" are only real if something looks
 * at the bytes, and the bytes only reach a server here. A résumé is served to
 * every visitor of a published portfolio, so "the browser said it was a PDF"
 * is not a good enough answer for what it is.
 */
uploadsRoute.post("/:kind", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);
	const log = c.get("log");

	const kind = c.req.param("kind");
	if (!isUploadKind(kind)) {
		return c.json({ error: "unknown_kind", message: "There's nothing to upload here." }, 404);
	}
	const rules = UPLOAD_RULES[kind];

	// Cheap rejection before buffering: a browser always sends Content-Length
	// for a FormData upload, so an oversized file is turned away before its
	// body is read. Absence isn't fatal — file.size is checked either way.
	const declaredLength = Number(c.req.header("content-length") ?? Number.NaN);
	if (Number.isFinite(declaredLength) && declaredLength > rules.maxBytes + MULTIPART_OVERHEAD_BYTES) {
		log?.warn("upload rejected before read: content-length over cap", {
			userId: user.id,
			kind,
			declaredLength,
			maxBytes: rules.maxBytes,
		});
		return c.json(
			{
				error: "too_large",
				maxBytes: rules.maxBytes,
				message: `That ${rules.noun} is too large. The limit is ${mb(rules.maxBytes)}.`,
			},
			413,
		);
	}

	const form = await c.req.formData().catch(() => null);
	const file = form?.get("file");
	if (!(file instanceof File) || file.size === 0) {
		return c.json(
			{ error: "no_file", message: `Choose a ${rules.noun} to upload.` },
			400,
		);
	}

	const stored = await storeUpload(user.id, rules, file);
	if (!stored.ok) {
		log?.warn("upload rejected", {
			userId: user.id,
			kind,
			reason: stored.reason,
			size: file.size,
		});
		const status = stored.reason === "too_large" ? 413 : stored.reason === "storage_failed" ? 502 : 400;
		return c.json(
			{
				error: stored.reason,
				message: stored.message,
				maxBytes: rules.maxBytes,
				allowed: uploadFormatList(rules),
				...(stored.reason === "too_large" ? { size: stored.size } : {}),
			},
			status,
		);
	}

	// Collect anything left over from an earlier upload of this kind, keeping
	// the object the SAVED profile still points at — the client hasn't written
	// the new URL yet, and a user who closes the tab between the upload and
	// the save must not come back to a portfolio with a dead link.
	const profile = await prisma.profile.findUnique({ where: { userId: user.id } });
	const referenced = objectPathFromUrl(currentUrlFor(profile?.data, kind));
	await pruneUploads(user.id, kind, [stored.path, ...(referenced ? [referenced] : [])]);

	return c.json({
		url: stored.url,
		filename: stored.filename,
		contentType: stored.contentType,
		size: stored.size,
	});
});

/**
 * Removes this account's stored files of one kind.
 *
 * The client is expected to clear the field and save the profile BEFORE
 * calling this, so a failure here leaves an orphaned object (harmless) rather
 * than a profile pointing at a deleted one (a broken image on a live site).
 */
uploadsRoute.delete("/:kind", async (c) => {
	const user = c.get("user");
	if (!user) return c.json({ error: "unauthorized" }, 401);

	const kind = c.req.param("kind");
	if (!isUploadKind(kind)) {
		return c.json({ error: "unknown_kind", message: "There's nothing to remove here." }, 404);
	}

	await pruneUploads(user.id, kind, []);
	return c.body(null, 204);
});

/** The URL the saved profile currently has for this kind, if any. */
function currentUrlFor(data: unknown, kind: "avatar" | "resume"): string | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const profile = (data as { profile?: unknown }).profile;
	if (typeof profile !== "object" || profile === null) return undefined;
	const key = kind === "avatar" ? "avatarUrl" : "resumeUrl";
	const value = (profile as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function mb(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
