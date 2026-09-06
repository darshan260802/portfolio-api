import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { portfolioDataSchema } from "@pb/templates";
import type { Site } from "../../generated/prisma/client.js";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { SITE_URL_PLACEHOLDER } from "../lib/constants.js";
import { DEFAULT_BUILD_COMMAND, DEFAULT_BUILD_DIR, DEFAULT_INSTALL_COMMAND } from "../lib/git-source.js";
import { decryptSecret } from "../lib/secret-box.js";
import { materializeProject } from "./scaffold.service.js";
import { initialsFaviconDataUri } from "../lib/favicon.js";
import { localizeAssets } from "./assets.service.js";
import { cloneAndBuild } from "./git-build.service.js";
import { publish } from "./hosting.service.js";
import { log } from "../lib/logger.js";
import type { Logger } from "../lib/logger.js";

const MAX_LOG_CHARS = 20_000;
const builderLog = log.child("builder");

/**
 * Hardlink-copies the prewarmed node_modules for `templateId` into
 * `buildDir` — `cp -al` (BSD and GNU both support -a/-l) instead of a
 * symlink, because Vite realpaths through symlinks by default and can
 * resolve React outside the build root. Near-zero cost on the same
 * filesystem; each build gets real, independent paths.
 * See the design doc's "Resolved implementation mechanics" #5.
 */
async function hardlinkCopyNodeModules(templateId: string, buildDir: string): Promise<void> {
	const src = join(env.TEMPLATES_DIR, ".prewarm", templateId, "node_modules");
	const dest = join(buildDir, "node_modules");
	const proc = Bun.spawn(["cp", "-al", src, dest], { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`cp -al node_modules failed (exit ${exitCode}): ${stderr}`);
	}
}

interface ViteBuildResult {
	ok: boolean;
	log: string;
	timedOut: boolean;
}

/**
 * Spawns the Vite binary directly (never through `bun x`/`bun run` — a
 * shell wrapper survives SIGTERM and orphans the real build). SIGKILL on
 * timeout because SIGTERM may not stop a wedged native Rolldown thread.
 * See the design doc's "Resolved implementation mechanics" #9.
 */
async function runViteBuild(buildDir: string): Promise<ViteBuildResult> {
	const proc = Bun.spawn(
		[process.execPath, join(buildDir, "node_modules/vite/bin/vite.js"), "build"],
		{
			cwd: buildDir,
			timeout: env.BUILD_TIMEOUT_MS,
			killSignal: "SIGKILL",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, NODE_ENV: "production", CI: "1" },
		},
	);

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	const log = `${stdout}\n${stderr}`.trim().slice(-MAX_LOG_CHARS);
	const timedOut = proc.signalCode === "SIGKILL" && exitCode !== 0;
	return { ok: exitCode === 0, log, timedOut };
}

async function failDeployment(deploymentId: string, log: string): Promise<void> {
	await prisma.deployment.update({
		where: { id: deploymentId },
		data: { status: "FAILED", log: log.slice(-MAX_LOG_CHARS), finishedAt: new Date() },
	});
}

/**
 * Publishes a finished build and records the deployment as LIVE.
 *
 * Shared by both pipelines on purpose: whether the HTML came from one of
 * our templates or from a stranger's `bun run build`, "what it means to be
 * published" is the same thing — a release directory, an atomic symlink
 * swap, and a Site row pointing at the deployment that's actually serving.
 */
async function publishDeployment(
	deploymentId: string,
	site: Site,
	builtDir: string,
	buildLog: string,
	runLog: Logger,
	startedAt: number,
): Promise<void> {
	const { releaseDir, url } = publish(site.slug, deploymentId, builtDir);

	await prisma.$transaction([
		prisma.deployment.update({
			where: { id: deploymentId },
			data: { status: "LIVE", releaseDir, log: buildLog.slice(-MAX_LOG_CHARS), finishedAt: new Date() },
		}),
		prisma.site.update({
			where: { id: site.id },
			data: { status: "LIVE", currentDeploymentId: deploymentId },
		}),
	]);

	runLog.info("deployment published", { url, durationMs: Math.round(performance.now() - startedAt) });
}

/**
 * The templated pipeline: materialize -> localize assets -> hardlink deps ->
 * vite build -> publish. Builds our own code from the account's profile.
 */
async function runTemplateDeployment(
	deploymentId: string,
	site: Site,
	runLog: Logger,
	startedAt: number,
): Promise<void> {
	if (!site.templateId) {
		await failDeployment(deploymentId, "This site has no template selected.");
		return;
	}
	const templateId = site.templateId;

	const profile = await prisma.profile.findUnique({ where: { userId: site.userId } });
	if (!profile) {
		runLog.error("no profile found for account");
		await failDeployment(deploymentId, "No profile found for this account.");
		return;
	}

	const buildDir = mkdtempSync(join(env.BUILD_TMP_DIR, "build-"));
	try {
		const data = portfolioDataSchema.parse(profile.data);

		runLog.debug("localizing assets");
		const localized = await localizeAssets(data, buildDir);

		runLog.debug("materializing project");
		materializeProject({
			targetDir: buildDir,
			templateId,
			data: localized,
			projectName: site.slug,
			siteTitle: data.seo?.title || data.profile.fullName || "My Portfolio",
			siteDescription: data.seo?.description || data.profile.headline || "",
			siteUrl: SITE_URL_PLACEHOLDER, // rewritten at publish time, not here
			siteOgImage: data.seo?.ogImageUrl ?? localized.profile.avatarUrl ?? "",
			siteFavicon: initialsFaviconDataUri(data.profile.fullName || site.slug),
		});

		runLog.debug("hardlinking prewarmed node_modules");
		await hardlinkCopyNodeModules(templateId, buildDir);

		runLog.debug("running vite build");
		const result = await runViteBuild(buildDir);
		if (!result.ok) {
			const reason = result.timedOut ? `Build timed out after ${env.BUILD_TIMEOUT_MS}ms.\n\n` : "";
			runLog.error("vite build failed", { timedOut: result.timedOut });
			await failDeployment(deploymentId, reason + result.log);
			return;
		}

		await publishDeployment(deploymentId, site, join(buildDir, "dist"), result.log, runLog, startedAt);
	} finally {
		rmSync(buildDir, { recursive: true, force: true });
	}
}

/**
 * The bring-your-own-repo pipeline: clone the user's public repository, run
 * their install and build commands, publish what their build folder
 * contains, and delete the checkout.
 *
 * The checkout is removed in `finally` whatever happens — a failed build
 * leaves node_modules and a full source tree behind, and a build box that
 * keeps those around fills its disk long before anyone notices.
 */
async function runGitDeployment(
	deploymentId: string,
	site: Site,
	runLog: Logger,
	startedAt: number,
): Promise<void> {
	if (!site.gitRepoUrl) {
		await failDeployment(deploymentId, "This site has no repository configured.");
		return;
	}

	let envVars: Record<string, string>;
	try {
		envVars = await decryptSiteEnvVars(site.id);
	} catch (err) {
		// Refusing to build is the right answer: a build that silently runs
		// without the variable it needs produces a broken site that looks
		// like a successful deploy.
		runLog.error("could not decrypt site environment variables", { err });
		await failDeployment(
			deploymentId,
			"Your saved environment variables couldn't be read. Re-enter them in Settings and try again.",
		);
		return;
	}

	const workDir = mkdtempSync(join(env.BUILD_TMP_DIR, "gitbuild-"));
	try {
		runLog.info("cloning and building user repository", {
			repoUrl: site.gitRepoUrl,
			branch: site.gitBranch,
			envVarCount: Object.keys(envVars).length,
		});

		const result = await cloneAndBuild({
			repoUrl: site.gitRepoUrl,
			branch: site.gitBranch,
			installCommand: site.installCommand ?? DEFAULT_INSTALL_COMMAND,
			buildCommand: site.buildCommand ?? DEFAULT_BUILD_COMMAND,
			buildDir: site.buildDir ?? DEFAULT_BUILD_DIR,
			envVars,
			workDir,
		});

		if (!result.ok) {
			runLog.error("user repository build failed", { failure: result.failure });
			await failDeployment(deploymentId, `${result.failure}\n\n${result.log}`);
			return;
		}

		await publishDeployment(deploymentId, site, result.outDir, result.log, runLog, startedAt);
	} finally {
		// "Move the build into the serve directory and delete the project" —
		// publish() has already copied the output into .releases/<slug>/, so
		// the entire checkout goes.
		rmSync(workDir, { recursive: true, force: true });
	}
}

/** Reads a site's stored variables back into a plain env map for the build. */
async function decryptSiteEnvVars(siteId: string): Promise<Record<string, string>> {
	const rows = await prisma.siteEnvVar.findMany({ where: { siteId }, orderBy: { key: "asc" } });
	const out: Record<string, string> = {};
	for (const row of rows) {
		out[row.key] = decryptSecret(row.valueCipher);
	}
	return out;
}

/**
 * Runs one full deploy and records LIVE, or FAILED with a trimmed log,
 * dispatching on where the site's content comes from. Always cleans up its
 * temp directories. Intended to be called from inside the build queue (see
 * queue.service.ts), one at a time per queue slot.
 */
export async function runDeployment(deploymentId: string): Promise<void> {
	const deployment = await prisma.deployment.findUnique({
		where: { id: deploymentId },
		include: { site: true },
	});
	if (!deployment) {
		builderLog.error("deployment not found", { deploymentId });
		return;
	}
	const { site } = deployment;
	const runLog = builderLog.child(deploymentId, {
		siteId: site.id,
		slug: site.slug,
		source: site.source,
		templateId: site.templateId,
	});

	await prisma.deployment.update({
		where: { id: deploymentId },
		data: { status: "BUILDING", startedAt: new Date() },
	});
	runLog.info("build started", { source: site.source });
	const startedAt = performance.now();

	try {
		if (site.source === "GIT") {
			await runGitDeployment(deploymentId, site, runLog, startedAt);
		} else {
			await runTemplateDeployment(deploymentId, site, runLog, startedAt);
		}
	} catch (err) {
		runLog.error("deployment failed with an internal error", { err });
		await failDeployment(deploymentId, `Internal error: ${(err as Error).stack ?? err}`);
	}
}

/** Marks any deployment orphaned mid-build by an API restart as FAILED. */
export async function reapOrphanedBuilds(): Promise<void> {
	const { count } = await prisma.deployment.updateMany({
		where: { status: "BUILDING" },
		data: { status: "FAILED", log: "Orphaned by an API restart mid-build.", finishedAt: new Date() },
	});
	if (count > 0) {
		builderLog.warn("reaped orphaned BUILDING deployment(s) on boot", { count });
	}
}
