import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { env } from "../env.js";
import { SITE_URL_PLACEHOLDER } from "../lib/constants.js";

const releasesRoot = (slug: string) => join(env.PORTFOLIOS_DIR, ".releases", slug);
const releaseDirFor = (slug: string, deploymentId: string) => join(releasesRoot(slug), deploymentId);
const slugLinkPath = (slug: string) => join(env.PORTFOLIOS_DIR, slug);

/**
 * Symlinks `linkPath -> target` atomically: symlink to a temp name in the
 * SAME directory, then rename(2) over the old link. Plain `ln -sfn` is not
 * atomic (unlink-then-symlink leaves a real 404 window); this is.
 * See the design doc's "Resolved implementation mechanics" #6.
 */
function atomicSymlink(target: string, linkPath: string): void {
	const tmp = `${linkPath}.tmp.${process.pid}.${Date.now()}`;
	symlinkSync(target, tmp);
	renameSync(tmp, linkPath);
}

function rewriteSiteUrlPlaceholder(releaseDir: string, siteUrl: string): void {
	for (const filename of ["index.html", "sitemap.xml", "robots.txt"]) {
		const path = join(releaseDir, filename);
		if (!existsSync(path)) continue;
		const contents = readFileSync(path, "utf8");
		if (!contents.includes(SITE_URL_PLACEHOLDER)) continue;
		writeFileSync(path, contents.replaceAll(SITE_URL_PLACEHOLDER, siteUrl));
	}
}

function pruneOldReleases(slug: string, keep: number): void {
	const root = releasesRoot(slug);
	if (!existsSync(root)) return;

	const currentTarget = existsSync(slugLinkPath(slug)) ? readlinkSync(slugLinkPath(slug)) : null;

	const releases = readdirSync(root)
		.map((name) => ({ name, path: join(root, name) }))
		.filter((r) => lstatSync(r.path).isDirectory())
		.sort((a, b) => lstatSync(b.path).mtimeMs - lstatSync(a.path).mtimeMs);

	for (const release of releases.slice(keep)) {
		if (release.path === currentTarget) continue; // never delete what's live
		rmSync(release.path, { recursive: true, force: true });
	}
}

export interface PublishResult {
	releaseDir: string;
	url: string;
}

/**
 * Copies a built dist/ into `.releases/<slug>/<deploymentId>/`, rewrites
 * the SITE_URL_PLACEHOLDER left in the HTML by the build (see
 * scaffold.service's SITE_URL_PLACEHOLDER usage for host builds), then
 * atomically repoints `PORTFOLIOS_DIR/<slug>` at it. nginx already serves
 * `PORTFOLIOS_DIR/<slug>` unchanged — this only ever swaps what that path
 * resolves to.
 */
export function publish(slug: string, deploymentId: string, builtDistDir: string): PublishResult {
	const releaseDir = releaseDirFor(slug, deploymentId);
	mkdirSync(dirname(releaseDir), { recursive: true });
	cpSync(builtDistDir, releaseDir, { recursive: true });

	const url = `https://${slug}.${env.PORTFOLIO_DOMAIN}/`;
	rewriteSiteUrlPlaceholder(releaseDir, url);

	atomicSymlink(releaseDir, slugLinkPath(slug));
	pruneOldReleases(slug, env.RELEASES_TO_KEEP);

	return { releaseDir, url };
}

/**
 * Step 1 of a slug rename: point the NEW slug at whatever release the OLD
 * slug currently serves, without touching the old slug yet. The caller
 * (routes/deploy.ts) verifies the new subdomain responds, then commits the
 * DB slug change, and only THEN calls unpublishSlug(oldSlug) — so there is
 * never a moment where the site 404s, only a few seconds where both slugs
 * resolve to the same release.
 */
export function pointNewSlugAtExisting(oldSlug: string, newSlug: string): { url: string } {
	const oldLink = slugLinkPath(oldSlug);
	if (!existsSync(oldLink)) {
		throw new Error(`No published release for slug "${oldSlug}"`);
	}
	const target = readlinkSync(oldLink);
	atomicSymlink(target, slugLinkPath(newSlug));
	return { url: `https://${newSlug}.${env.PORTFOLIO_DOMAIN}/` };
}

/** Removes a slug's symlink (not its release history). Safe to call twice. */
export function unpublishSlug(slug: string): void {
	const link = slugLinkPath(slug);
	if (existsSync(link)) unlinkSync(link);
}

/**
 * Best-effort orphan cleanup: removes `.releases/<slug>` directories and
 * top-level slug symlinks that have no matching entry in `knownSlugs`, but
 * only ones untouched for a while — so this can never race an in-flight
 * publish. Intended to run on a schedule, not per-request.
 */
export function reconcileOrphans(knownSlugs: Set<string>, olderThanMs = 6 * 60 * 60 * 1000): void {
	if (!existsSync(env.PORTFOLIOS_DIR)) return;
	const cutoff = Date.now() - olderThanMs;

	for (const entry of readdirSync(env.PORTFOLIOS_DIR)) {
		if (entry === ".releases") continue;
		const path = join(env.PORTFOLIOS_DIR, entry);
		const stat = lstatSync(path);
		if (!stat.isSymbolicLink()) continue;
		if (knownSlugs.has(entry)) continue;
		if (stat.mtimeMs > cutoff) continue;
		unlinkSync(path);
	}

	const releasesRootDir = join(env.PORTFOLIOS_DIR, ".releases");
	if (!existsSync(releasesRootDir)) return;
	for (const slug of readdirSync(releasesRootDir)) {
		if (knownSlugs.has(slug)) continue;
		const path = join(releasesRootDir, slug);
		if (lstatSync(path).mtimeMs > cutoff) continue;
		rmSync(path, { recursive: true, force: true });
	}
}
