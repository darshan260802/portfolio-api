import { z } from "zod";

/**
 * Where a user's own portfolio repository may be cloned from when
 * GIT_ALLOWED_HOSTS isn't set. Public forges only — see that var's comment
 * for why this is an allowlist and not a denylist.
 */
const DEFAULT_GIT_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"];

/**
 * All configuration the API needs, validated once at boot. Fail fast:
 * a missing/malformed var should crash startup, never surface as a
 * confusing runtime error three requests later.
 */
const envSchema = z.object({
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
	PORT: z.coerce.number().int().positive().default(3000),

	// Supabase Postgres — DATABASE_URL is the Supavisor transaction pooler
	// (port 6543, ?pgbouncer=true&connection_limit=1); DIRECT_URL is the
	// direct connection (port 5432), used only by `prisma migrate`.
	DATABASE_URL: z.string().url(),
	DIRECT_URL: z.string().url(),

	BETTER_AUTH_SECRET: z.string().min(32),
	BETTER_AUTH_URL: z.string().url(),

	GOOGLE_CLIENT_ID: z.string().min(1),
	GOOGLE_CLIENT_SECRET: z.string().min(1),
	GITHUB_CLIENT_ID: z.string().min(1),
	GITHUB_CLIENT_SECRET: z.string().min(1),

	RESEND_API_KEY: z.string().min(1),
	// A "From" header value, not necessarily a bare address — Resend and
	// friends accept "Display Name <email@domain>" too. Accepts either a
	// bare email or "Display Name <email@domain>" (with or without the
	// space before "<" — lib/mailer.ts normalizes that before it ever
	// reaches Resend, since Resend's parser is strict about it).
	EMAIL_FROM: z
		.string()
		.min(3)
		.regex(
			/^(?:[^<>]+<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>|[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)$/,
			'Expected "email@domain" or "Display Name <email@domain>"',
		),

	SUPABASE_URL: z.string().url(),
	SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
	SUPABASE_BUCKET: z.string().min(1).default("portfolio-uploads"),

	// Filesystem paths the build/publish pipeline reads and writes.
	TEMPLATES_DIR: z.string().min(1),
	PORTFOLIOS_DIR: z.string().min(1),
	BUILD_TMP_DIR: z.string().min(1),

	PORTFOLIO_DOMAIN: z.string().min(1),
	MAX_CONCURRENT_BUILDS: z.coerce.number().int().positive().default(2),
	BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
	RELEASES_TO_KEEP: z.coerce.number().int().positive().default(5),

	// ---- Bring-your-own-repo hosting ----

	// The hosts a user's public repository may be cloned from. This is the
	// SSRF boundary, not a convenience filter: "clone whatever URL the user
	// typed" would let anyone point our build box at an internal address
	// (169.254.169.254, a metadata service, a private git server) and read
	// the response back out of the build log. Comma/space/newline separated;
	// empty falls back to the well-known public forges.
	GIT_ALLOWED_HOSTS: z
		.string()
		.optional()
		.transform((raw) => {
			const hosts = (raw ?? "")
				.split(/[\s,]+/)
				.map((h) => h.trim().toLowerCase())
				.filter(Boolean);
			return hosts.length > 0 ? hosts : DEFAULT_GIT_HOSTS;
		}),
	GIT_CLONE_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
	// Dependency installs are routinely slower than a build, so they get
	// their own (longer) budget rather than sharing BUILD_TIMEOUT_MS.
	GIT_INSTALL_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
	// Checked right after the clone, before a single dependency is fetched.
	GIT_MAX_REPO_MB: z.coerce.number().int().positive().default(250),

	// Encrypts the build-time environment variables users attach to their
	// repo (see lib/secret-box.ts). Optional: when unset the key is derived
	// from BETTER_AUTH_SECRET via HKDF with a distinct info string, so the
	// two are never the same bytes. Set it explicitly if you ever want to
	// rotate the auth secret without invalidating every stored value.
	SITE_ENV_SECRET: z.string().min(32).optional(),

	// Origin(s) the browser app runs on — used for CORS and Better Auth's
	// trustedOrigins/crossSubDomainCookies.
	WEB_ORIGIN: z.string().url(),
	COOKIE_DOMAIN: z.string().min(1),

	// Extra reserved subdomains, merged with the built-in blocklist in
	// lib/slug.ts (never replaces it — a bad env value can only add
	// restrictions, never lift one). Comma/space/newline separated, e.g.
	// "status,cdn2,internal". Optional; defaults to nothing extra.
	RESERVED_SLUGS: z
		.string()
		.optional()
		.transform((raw) =>
			(raw ?? "")
				.split(/[\s,]+/)
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean),
		),

	// Outbound notification webhook: every portfolio lifecycle event (a site
	// created, its template or subdomain changed, a publish that went live
	// or failed) is POSTed here as JSON. Optional — leave it unset and
	// services/webhook.service.ts turns every notify() into a no-op, so the
	// API runs unchanged in dev and in setups that don't want it.
	NOTIFY_WEBHOOK_URL: z.string().url().optional(),
	// Shared secret for the HMAC-SHA256 signature sent as x-pb-signature.
	// Optional, but strongly recommended: without it the receiver has no way
	// to tell a real delivery from anyone who guessed the URL.
	NOTIFY_WEBHOOK_SECRET: z.string().min(16).optional(),
	NOTIFY_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

	LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
	const parsed = envSchema.safeParse(process.env);
	if (!parsed.success) {
		console.error("Invalid environment configuration:");
		for (const issue of parsed.error.issues) {
			console.error(`  ${issue.path.join(".")}: ${issue.message}`);
		}
		process.exit(1);
	}

	// resend.dev's shared onboarding sender only ever delivers to the
	// Resend account owner's own inbox — it silently can't reach real
	// users. That's exactly the trap this project already fell into once
	// (see lib/mailer.ts). Fine in dev for smoke-testing; fatal in prod.
	if (parsed.data.NODE_ENV === "production" && /@resend\.dev>?$/i.test(parsed.data.EMAIL_FROM.trim())) {
		console.error(
			`Invalid environment configuration:\n  EMAIL_FROM: "${parsed.data.EMAIL_FROM}" uses Resend's ` +
				`shared test domain (@resend.dev), which only delivers to the Resend account owner. ` +
				`Verify a real sending domain in Resend and point EMAIL_FROM at it before deploying.`,
		);
		process.exit(1);
	}

	return parsed.data;
}

export const env = loadEnv();
