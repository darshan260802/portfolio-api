import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { portfolioDataSchema } from "@pb/templates";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { SITE_URL_PLACEHOLDER } from "../lib/constants.js";
import { materializeProject } from "./scaffold.service.js";
import { initialsFaviconDataUri } from "../lib/favicon.js";
import { localizeAssets } from "./assets.service.js";
import { publish } from "./hosting.service.js";
import { notify } from "./webhook.service.js";
import { log } from "../lib/logger.js";

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
 * Runs one full deploy: materialize -> localize assets -> hardlink deps ->
 * vite build -> publish -> record LIVE, or FAILED with a trimmed log.
 * Always cleans up the temp build dir. Intended to be called from inside
 * the build queue (see queue.service.ts), one at a time per queue slot.
 */
export async function runDeployment(deploymentId: string): Promise<void> {
	const deployment = await prisma.deployment.findUnique({
		where: { id: deploymentId },
		// The owner comes along for the ride so the notification webhook can
		// say *whose* portfolio this is without a second round-trip.
		include: { site: { include: { user: { select: { id: true, email: true, name: true } } } } },
	});
	if (!deployment) {
		builderLog.error("deployment not found", { deploymentId });
		return;
	}
	const { site } = deployment;
	const runLog = builderLog.child(deploymentId, { siteId: site.id, slug: site.slug, templateId: site.templateId });

	// A site whose currentDeploymentId is still null has never served
	// anything — this run is the moment the portfolio first goes online.
	const isFirstPublish = site.currentDeploymentId === null;
	const url = `https://${site.slug}.${env.PORTFOLIO_DOMAIN}/`;
	const eventData = {
		deploymentId,
		siteId: site.id,
		slug: site.slug,
		templateId: site.templateId,
		url,
		isFirstPublish,
		user: { id: site.user.id, email: site.user.email, name: site.user.name },
	};

	/** Records the failure AND tells the webhook — the two always go together. */
	const fail = async (logText: string, reason: string): Promise<void> => {
		await failDeployment(deploymentId, logText);
		notify("site.publish_failed", { ...eventData, reason });
	};

	const templateId = site.templateId;
	if (!templateId) {
		runLog.error("no template selected for site");
		await fail("No template selected for this site.", "no_template");
		return;
	}

	const profile = await prisma.profile.findUnique({ where: { userId: site.userId } });
	if (!profile) {
		runLog.error("no profile found for account");
		await fail("No profile found for this account.", "no_profile");
		return;
	}

	await prisma.deployment.update({
		where: { id: deploymentId },
		data: { status: "BUILDING", startedAt: new Date() },
	});
	runLog.info("build started");
	const startedAt = performance.now();

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
			await fail(reason + result.log, result.timedOut ? "build_timeout" : "build_failed");
			return;
		}

		const { releaseDir, url: publishedUrl } = publish(site.slug, deploymentId, join(buildDir, "dist"));

		await prisma.$transaction([
			prisma.deployment.update({
				where: { id: deploymentId },
				data: { status: "LIVE", releaseDir, log: result.log.slice(-MAX_LOG_CHARS), finishedAt: new Date() },
			}),
			prisma.site.update({
				where: { id: site.id },
				data: { status: "LIVE", currentDeploymentId: deploymentId },
			}),
		]);

		const durationMs = Math.round(performance.now() - startedAt);
		runLog.info("deployment published", { url: publishedUrl, durationMs });
		notify("site.published", { ...eventData, url: publishedUrl, durationMs });
	} catch (err) {
		runLog.error("deployment failed with an internal error", { err });
		await fail(`Internal error: ${(err as Error).stack ?? err}`, "internal_error");
	} finally {
		rmSync(buildDir, { recursive: true, force: true });
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
