import { randomUUID } from "node:crypto";
import {
	type UploadKind,
	type UploadRules,
	uploadFormatForBytes,
	uploadFormatList,
} from "@pb/templates";
import { env } from "../env.js";
import { log } from "../lib/logger.js";
import { supabase } from "../lib/supabase.js";

const uploadsLog = log.child("uploads");

/** Where one account's files of one kind live. Every path here is scoped to it. */
function prefixFor(userId: string, kind: UploadKind): string {
	return `${userId}/${kind}`;
}

export type StoreFailure =
	| { ok: false; reason: "too_large"; message: string; size: number }
	| { ok: false; reason: "unsupported_format"; message: string }
	| { ok: false; reason: "storage_failed"; message: string };

export interface StoredUpload {
	ok: true;
	/** Object path inside the bucket. */
	path: string;
	/** Public URL — what goes into PortfolioData. */
	url: string;
	/** The name to show the user and to hand a visitor's browser on download. */
	filename: string;
	contentType: string;
	size: number;
}

/**
 * Validates and stores one uploaded file.
 *
 * The size cap and the format are both enforced HERE, on the bytes the server
 * actually received, because nothing earlier in the chain can be trusted to:
 * the filename and the browser-declared Content-Type are attacker-controlled,
 * and Supabase's signed upload URLs (still used for project images) carry no
 * size or type constraint of their own — a bucket-level limit is the only
 * other lever, and it can't differ per kind. So the format is decided by
 * sniffing the file's magic bytes, and the stored object's extension and
 * content type come from what the bytes actually are, never from what the
 * upload claimed.
 */
export async function storeUpload(
	userId: string,
	rules: UploadRules,
	file: File,
): Promise<StoredUpload | StoreFailure> {
	if (file.size > rules.maxBytes) {
		return {
			ok: false,
			reason: "too_large",
			// Deliberately not "is 5.0 MB, the limit is 5.0 MB" — one byte over
			// the cap rounds to the cap at any sane precision, and a message
			// that contradicts itself reads as a bug. The exact sizes go back in
			// the response body for a client that wants to be specific.
			message: `That ${rules.noun} is too large. The limit is ${formatMb(rules.maxBytes)}.`,
			size: file.size,
		};
	}

	const bytes = new Uint8Array(await file.arrayBuffer());
	const format = uploadFormatForBytes(rules, bytes);
	if (!format) {
		return {
			ok: false,
			reason: "unsupported_format",
			message: `That file isn't a ${uploadFormatList(rules)}. Pick a different ${rules.noun}.`,
		};
	}

	const extension = format.extensions[0] ?? "";
	const filename = safeFilename(file.name, extension, rules.noun);
	const path = `${prefixFor(userId, rules.kind)}/${randomUUID()}.${extension}`;

	const { error } = await supabase.storage.from(env.SUPABASE_BUCKET).upload(path, bytes, {
		contentType: format.mimeType,
		// Every object gets a fresh UUID, so a collision would be a bug, not a
		// replacement — let it fail loudly rather than overwrite something.
		upsert: false,
		cacheControl: "3600",
	});

	if (error) {
		uploadsLog.error("storage upload failed", { userId, kind: rules.kind, path, err: error });
		return {
			ok: false,
			reason: "storage_failed",
			message: `Couldn't save your ${rules.noun}. Try again.`,
		};
	}

	const { data: publicUrlData } = supabase.storage.from(env.SUPABASE_BUCKET).getPublicUrl(path);

	uploadsLog.info("upload stored", {
		userId,
		kind: rules.kind,
		path,
		format: format.label,
		size: bytes.byteLength,
	});

	return {
		ok: true,
		path,
		url: publicUrlData.publicUrl,
		filename,
		contentType: format.mimeType,
		size: bytes.byteLength,
	};
}

/**
 * Deletes this account's stored files of one kind, except any path in `keep`.
 *
 * Called after a successful upload (keeping the new object and whatever the
 * saved profile still points at) and on an explicit removal (keeping nothing).
 * Deliberately not called on every profile save: the wizard saves on every
 * step, and two storage round-trips per step to collect garbage that only
 * appears on upload is the wrong trade.
 *
 * Best-effort. A leftover object costs a few KB of bucket; a failed request
 * costs the user their upload, so a failure here is logged and swallowed.
 */
export async function pruneUploads(
	userId: string,
	kind: UploadKind,
	keep: readonly string[],
): Promise<void> {
	const prefix = prefixFor(userId, kind);
	const keepSet = new Set(keep);

	const { data: existing, error } = await supabase.storage
		.from(env.SUPABASE_BUCKET)
		.list(prefix, { limit: 100 });

	if (error) {
		uploadsLog.warn("could not list stored uploads to prune", { userId, kind, err: error });
		return;
	}

	const stale = (existing ?? [])
		.map((object) => `${prefix}/${object.name}`)
		.filter((path) => !keepSet.has(path));

	if (stale.length === 0) return;

	const { error: removeError } = await supabase.storage.from(env.SUPABASE_BUCKET).remove(stale);
	if (removeError) {
		uploadsLog.warn("could not remove superseded uploads", { userId, kind, err: removeError });
		return;
	}

	uploadsLog.info("pruned superseded uploads", { userId, kind, removed: stale.length });
}

/**
 * The object path a public URL refers to, if it points at this bucket at all.
 * Used to work out which stored object the saved profile still depends on, so
 * pruning doesn't delete the file the live site is currently serving.
 */
export function objectPathFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const marker = `/storage/v1/object/public/${env.SUPABASE_BUCKET}/`;
	const index = url.indexOf(marker);
	if (index === -1) return undefined;
	const path = url.slice(index + marker.length).split(/[?#]/, 1)[0];
	return path ? decodeURIComponent(path) : undefined;
}

/**
 * The uploaded name, made safe to store and to hand back as a download name.
 *
 * The extension is replaced with the one the sniffed format dictates, so a PDF
 * named "cv.docx" is offered to visitors as "cv.pdf" — the alternative is a
 * download whose name lies about what it contains. The result has to satisfy
 * the shared schema's `resumeFilename` rule (no path separators, one of the
 * allowed extensions, ≤120 chars), because it is written straight into
 * PortfolioData by the client.
 */
function safeFilename(rawName: string, extension: string, fallbackNoun: string): string {
	const base = rawName
		.split(/[/\\]/)
		.pop()!
		// Control characters, plus the quote bytes that would need escaping if
		// this name ever reached a Content-Disposition header.
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f"']/g, "")
		// Drop whatever extension came in — the sniffed format decides it.
		.replace(/\.[^.]*$/, "")
		.trim();

	const suffix = `.${extension}`;
	const cleaned = base.length > 0 ? base : fallbackNoun.replace(/\s+/g, "-");
	return `${cleaned.slice(0, 120 - suffix.length)}${suffix}`;
}

function formatMb(bytes: number): string {
	const mb = bytes / (1024 * 1024);
	return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}
