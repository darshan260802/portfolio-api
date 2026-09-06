import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { env } from "../env.js";
import { parseCommand } from "../lib/git-source.js";
import { log } from "../lib/logger.js";

/**
 * Clones a user's own public repository, runs their install and build
 * commands, and hands back the folder their build wrote into — the "bring
 * your own project" counterpart to scaffold.service + the templated Vite
 * build.
 *
 * The interesting difference from the template pipeline isn't the steps,
 * it's what the subprocesses are allowed to see and do:
 *
 * - **argv, never a shell.** Commands arrive as strings, are parsed by
 *   `parseCommand` (which rejects anything shell-shaped) and spawned as an
 *   argv array. There is no `sh -c` anywhere in this file, so there is
 *   nothing for a `;` to break out of.
 * - **A built environment, not ours.** The template build inherits
 *   `process.env` because it runs our code. This one must not: our env holds
 *   `DATABASE_URL`, `BETTER_AUTH_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, and a
 *   build script can print anything it can read. Each step gets a small
 *   constructed env plus the user's own variables.
 * - **A budget per step.** Clone, install and build each get their own
 *   timeout and are SIGKILLed past it (SIGTERM is not reliably enough for a
 *   wedged native build thread — same reason as builder.service.ts), and the
 *   checkout is size-capped before dependencies are ever fetched.
 *
 * What it deliberately does *not* claim to be is a sandbox. Running a
 * stranger's build script is arbitrary code execution by definition; these
 * measures keep the inputs honest and the blast radius small, and a
 * container/VM boundary is what makes it actually contained. See the
 * README's "Hosting a user's own repository" section.
 */

const gitLog = log.child("git-build");

const MAX_STEP_LOG_CHARS = 8_000;

export interface GitBuildRequest {
	/** Normalized `https://host/owner/repo` — see lib/git-source.ts. */
	repoUrl: string;
	branch: string | null;
	installCommand: string;
	buildCommand: string;
	/** Repo-relative subpath the build writes into, e.g. "dist". */
	buildDir: string;
	/** Decrypted user variables, injected into install and build. */
	envVars: Record<string, string>;
	/** An empty directory the repository is cloned into. */
	workDir: string;
}

export type GitBuildResult =
	| { ok: true; outDir: string; log: string }
	| { ok: false; log: string; failure: string };

/**
 * Environment variables the toolchain itself needs, and which the user's
 * own variables are never allowed to replace. `lib/git-source.ts` already
 * refuses these names at the API boundary; re-applying them last here means
 * a value that somehow got stored before that check existed still can't
 * redirect the interpreter.
 */
function stepEnv(userEnv: Record<string, string>, defaults: Record<string, string> = {}): Record<string, string> {
	const home = bunHome();
	return {
		// Conveniences a build may legitimately want to change (a framework
		// that needs NODE_ENV=development to emit source maps, say) — so the
		// user's own variables are applied after them...
		CI: "1",
		...defaults,
		...userEnv,
		// ...and the toolchain's own wiring after that, where nothing the user
		// set can reach it.
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		// A dedicated HOME keeps Bun's install cache warm across builds
		// without exposing (or writing into) the API user's real home.
		HOME: home,
		LANG: process.env.LANG ?? "C.UTF-8",
		TZ: "UTC",
		NO_COLOR: "1",
		// git must never stop to ask for credentials — a private repo should
		// fail fast, not hang until the step times out.
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "/bin/true",
		SSH_ASKPASS: "/bin/true",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		// A shallow clone of a repo with big media shouldn't drag LFS objects
		// in; the site only needs what's committed.
		GIT_LFS_SKIP_SMUDGE: "1",
		// Even after the URL allowlist: a server-side redirect can't hop the
		// clone onto file:// or ext::.
		GIT_ALLOW_PROTOCOL: "https",
	};
}

function bunHome(): string {
	const home = join(env.BUILD_TMP_DIR, ".bun-home");
	mkdirSync(home, { recursive: true });
	return home;
}

interface StepResult {
	ok: boolean;
	output: string;
	timedOut: boolean;
}

/** Spawns one argv, captures merged output, and enforces its own timeout. */
async function runStep(
	argv: string[],
	options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<StepResult> {
	const proc = Bun.spawn(argv, {
		cwd: options.cwd,
		env: options.env,
		timeout: options.timeoutMs,
		killSignal: "SIGKILL",
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	const output = `${stdout}\n${stderr}`.trim();
	return {
		ok: exitCode === 0,
		output: output.slice(-MAX_STEP_LOG_CHARS),
		timedOut: proc.signalCode === "SIGKILL" && exitCode !== 0,
	};
}

/** Kilobytes on disk, or null when `du` isn't available (never fatal). */
async function directorySizeKb(dir: string): Promise<number | null> {
	const proc = Bun.spawn(["du", "-sk", dir], { stdout: "pipe", stderr: "ignore" });
	const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) return null;
	const kb = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
	return Number.isFinite(kb) ? kb : null;
}

/**
 * Resolves the user's build folder against the real clone path.
 *
 * `normalizeBuildDir` already rejected `..` and absolute paths, but a
 * *symlink committed in the repository* is checked by neither — `dist ->
 * /etc` is a perfectly valid thing to commit, and publishing what it points
 * at would serve the host's filesystem on someone's subdomain. realpath both
 * sides and require containment.
 */
function resolveBuildOutput(cloneDir: string, buildDir: string): { ok: true; path: string } | { ok: false; message: string } {
	const target = join(cloneDir, buildDir);
	if (!existsSync(target)) {
		return {
			ok: false,
			message:
				`The build finished but "${buildDir}" doesn't exist. ` +
				`Check the build folder setting matches what your build writes.`,
		};
	}

	const realRoot = realpathSync(cloneDir);
	const realTarget = realpathSync(target);
	if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
		return { ok: false, message: `"${buildDir}" resolves outside the repository.` };
	}
	if (!statSync(realTarget).isDirectory()) {
		return { ok: false, message: `"${buildDir}" is a file — the build folder has to be a directory.` };
	}
	if (!existsSync(join(realTarget, "index.html"))) {
		return {
			ok: false,
			message:
				`"${buildDir}" has no index.html, so there'd be nothing to serve at your subdomain. ` +
				`Point the build folder at your build's output directory.`,
		};
	}
	return { ok: true, path: realTarget };
}

/**
 * Runs clone → install → build for one deployment and returns the directory
 * to publish. Never throws for an expected failure (a bad branch, a failing
 * build, a missing output folder): those come back as `ok: false` with a log
 * the user can read, because they're the user's to fix, not ours.
 */
export async function cloneAndBuild(request: GitBuildRequest): Promise<GitBuildResult> {
	const sections: string[] = [];
	const section = (title: string, body: string) => sections.push(`$ ${title}\n${body}`.trimEnd());
	const transcript = () => sections.join("\n\n");

	const cloneDir = join(request.workDir, "repo");

	// ---- Clone ----
	const cloneArgv = [
		"git",
		"clone",
		"--depth",
		"1",
		"--single-branch",
		"--no-tags",
		...(request.branch ? ["--branch", request.branch] : []),
		// `--` so a repo path can never be read as an option, belt-and-braces
		// alongside the URL validation.
		"--",
		request.repoUrl,
		cloneDir,
	];
	const cloned = await runStep(cloneArgv, {
		cwd: request.workDir,
		// No user variables during the clone: nothing they could set affects
		// fetching a public repository, and one of them going wrong here would
		// be a confusing failure before their build has even started.
		env: stepEnv({}),
		timeoutMs: env.GIT_CLONE_TIMEOUT_MS,
	});
	section(cloneArgv.join(" "), cloned.output);

	if (!cloned.ok) {
		const reason = cloned.timedOut
			? `Cloning timed out after ${env.GIT_CLONE_TIMEOUT_MS}ms.`
			: request.branch
				? `Couldn't clone ${request.repoUrl} at branch "${request.branch}". Check the repository is public and the branch exists.`
				: `Couldn't clone ${request.repoUrl}. Check the repository is public.`;
		return { ok: false, log: transcript(), failure: reason };
	}

	// ---- Size guard, before a single dependency is fetched ----
	const sizeKb = await directorySizeKb(cloneDir);
	if (sizeKb !== null) {
		const sizeMb = Math.round(sizeKb / 1024);
		section("checkout size", `${sizeMb} MB (limit ${env.GIT_MAX_REPO_MB} MB)`);
		if (sizeMb > env.GIT_MAX_REPO_MB) {
			return {
				ok: false,
				log: transcript(),
				failure: `That checkout is ${sizeMb} MB, over the ${env.GIT_MAX_REPO_MB} MB limit for a hosted build.`,
			};
		}
	}

	// ---- Install, then build ----
	// Re-parsed here rather than trusting a stored argv: the same function
	// that accepted the string at the API boundary is the one that turns it
	// into a process, so there's no path where a row edited around the API
	// becomes a different command.
	const steps: { label: string; command: string; timeoutMs: number }[] = [
		{ label: "install", command: request.installCommand, timeoutMs: env.GIT_INSTALL_TIMEOUT_MS },
		{ label: "build", command: request.buildCommand, timeoutMs: env.BUILD_TIMEOUT_MS },
	];

	for (const step of steps) {
		const parsed = parseCommand(step.command);
		if (!parsed.ok) {
			return { ok: false, log: transcript(), failure: `Invalid ${step.label} command: ${parsed.message}` };
		}

		const result = await runStep(parsed.value, {
			cwd: cloneDir,
			env: stepEnv(request.envVars, step.label === "build" ? { NODE_ENV: "production" } : {}),
			timeoutMs: step.timeoutMs,
		});
		section(step.command, result.output);

		if (!result.ok) {
			const reason = result.timedOut
				? `The ${step.label} step timed out after ${step.timeoutMs}ms.`
				: `The ${step.label} step failed — see the log above.`;
			return { ok: false, log: transcript(), failure: reason };
		}
	}

	// ---- Locate what to publish ----
	const output = resolveBuildOutput(cloneDir, request.buildDir);
	if (!output.ok) {
		return { ok: false, log: transcript(), failure: output.message };
	}

	gitLog.debug("git build produced output", { outDir: output.path, repoUrl: request.repoUrl });
	section("build output", request.buildDir);
	return { ok: true, outDir: output.path, log: transcript() };
}
