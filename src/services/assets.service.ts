import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { PortfolioData } from "@pb/templates";

/**
 * Downloads every asset URL referenced in `data` (Supabase Storage, at
 * signup time) into `<targetDir>/public/assets/` and returns a deep copy of
 * `data` with those URLs rewritten to `/assets/<file>` — so the generated
 * project (ZIP or hosted site) keeps working even if the account or the
 * storage bucket is later deleted.
 *
 * A failed download is logged and left pointing at the original remote URL
 * rather than failing the whole build — a broken image beats a broken
 * deploy.
 */
export async function localizeAssets(
	data: PortfolioData,
	targetDir: string,
): Promise<PortfolioData> {
	const assetsDir = join(targetDir, "public/assets");
	mkdirSync(assetsDir, { recursive: true });

	const cache = new Map<string, string | null>();

	async function localize(url: string | undefined): Promise<string | undefined> {
		if (!url) return url;
		if (cache.has(url)) {
			const cached = cache.get(url);
			return cached ?? url;
		}

		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const buffer = new Uint8Array(await res.arrayBuffer());

			const ext = extname(new URL(url).pathname) || guessExtension(res.headers.get("content-type"));
			const filename = `${createHash("sha256").update(url).digest("hex").slice(0, 16)}${ext}`;
			writeFileSync(join(assetsDir, filename), buffer);

			const localPath = `/assets/${filename}`;
			cache.set(url, localPath);
			return localPath;
		} catch (err) {
			console.warn(`[assets] failed to download "${url}": ${(err as Error).message}`);
			cache.set(url, null);
			return url;
		}
	}

	const result: PortfolioData = structuredClone(data);

	result.profile.avatarUrl = await localize(result.profile.avatarUrl);
	result.profile.resumeUrl = await localize(result.profile.resumeUrl);
	if (result.seo) {
		result.seo.ogImageUrl = await localize(result.seo.ogImageUrl);
	}
	if (result.projects) {
		for (const project of result.projects) {
			project.imageUrl = await localize(project.imageUrl);
		}
	}

	return result;
}

function guessExtension(contentType: string | null): string {
	switch (contentType) {
		case "image/png":
			return ".png";
		case "image/webp":
			return ".webp";
		case "image/gif":
			return ".gif";
		case "application/pdf":
			return ".pdf";
		case "image/jpeg":
			return ".jpg";
		default:
			return "";
	}
}
