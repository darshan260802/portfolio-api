import type { Prisma, Site } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { DEFAULT_BUILD_COMMAND, DEFAULT_BUILD_DIR, DEFAULT_INSTALL_COMMAND } from "../lib/git-source.js";
import type { GitSourceConfig } from "../lib/git-source.js";
import { encryptSecret } from "../lib/secret-box.js";
import { log } from "../lib/logger.js";

/**
 * Persisting and reading back a site's "build from my own repository"
 * configuration, kept out of the route so the storage rules for the
 * environment variables live next to each other rather than inline in a
 * handler.
 */

const sourceLog = log.child("site-source");

/** What the API is willing to say about a git source — note: keys, never values. */
export interface GitSourceView {
	repoUrl: string;
	branch: string | null;
	installCommand: string;
	buildCommand: string;
	buildDir: string;
	envKeys: string[];
}

/**
 * Thrown when the client asks to keep the stored value of a variable that
 * isn't stored — which in practice means the form was submitted against a
 * config that changed underneath it.
 */
export class MissingEnvValuesError extends Error {
	constructor(readonly keys: string[]) {
		super(`No stored value for: ${keys.join(", ")}`);
		this.name = "MissingEnvValuesError";
	}
}

/**
 * Writes a validated git config onto the site and switches it to the GIT
 * source.
 *
 * `templateId` is deliberately left alone: someone trying their own repo
 * shouldn't lose the template they picked, so switching back in Settings is
 * a one-click operation rather than a re-pick.
 *
 * Environment variables follow one rule worth stating plainly: **`env`
 * absent means "don't touch them", `env` present means "this is now the
 * complete set"** — anything not listed is deleted. Within the list, an
 * entry with no `value` keeps whatever is stored, which is what lets the
 * settings form round-trip secrets the API never sent it in the first
 * place. Everything is written in one transaction so a half-applied set
 * can't reach a build.
 */
export async function saveGitSource(siteId: string, config: GitSourceConfig): Promise<void> {
	const existing = await prisma.siteEnvVar.findMany({ where: { siteId }, select: { key: true } });
	const storedKeys = new Set(existing.map((row) => row.key));

	// Collected rather than awaited one by one: a half-applied set (the repo
	// updated, a variable not) is exactly what a build must never see.
	const writes: Prisma.PrismaPromise<unknown>[] = [
		prisma.site.update({
			where: { id: siteId },
			data: {
				source: "GIT",
				gitRepoUrl: config.repoUrl,
				gitBranch: config.branch,
				installCommand: config.installCommand,
				buildCommand: config.buildCommand,
				buildDir: config.buildDir,
			},
		}),
	];

	if (config.env) {
		const missing = config.env.filter((e) => e.value === undefined && !storedKeys.has(e.key)).map((e) => e.key);
		if (missing.length > 0) throw new MissingEnvValuesError(missing);

		const submitted = new Set(config.env.map((e) => e.key));
		const removed = [...storedKeys].filter((key) => !submitted.has(key));
		if (removed.length > 0) {
			writes.push(prisma.siteEnvVar.deleteMany({ where: { siteId, key: { in: removed } } }));
		}

		for (const entry of config.env) {
			if (entry.value === undefined) continue; // keep what's stored
			const valueCipher = encryptSecret(entry.value);
			writes.push(
				prisma.siteEnvVar.upsert({
					where: { siteId_key: { siteId, key: entry.key } },
					create: { siteId, key: entry.key, valueCipher },
					update: { valueCipher },
				}),
			);
		}
	}

	await prisma.$transaction(writes);
	sourceLog.info("git source saved", {
		siteId,
		repoUrl: config.repoUrl,
		branch: config.branch,
		envVarCount: config.env?.length,
	});
}

/**
 * The git config as the API reports it. Falls back to the documented
 * defaults for any column a row predates, so the client never has to know
 * which of them are nullable in the database.
 */
export async function readGitSource(site: Site): Promise<GitSourceView | null> {
	if (!site.gitRepoUrl) return null;

	const rows = await prisma.siteEnvVar.findMany({
		where: { siteId: site.id },
		select: { key: true },
		orderBy: { key: "asc" },
	});

	return {
		repoUrl: site.gitRepoUrl,
		branch: site.gitBranch,
		installCommand: site.installCommand ?? DEFAULT_INSTALL_COMMAND,
		buildCommand: site.buildCommand ?? DEFAULT_BUILD_COMMAND,
		buildDir: site.buildDir ?? DEFAULT_BUILD_DIR,
		envKeys: rows.map((row) => row.key),
	};
}
