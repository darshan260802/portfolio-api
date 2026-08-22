import { z } from "zod";

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
	EMAIL_FROM: z.string().email(),

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

	// Origin(s) the browser app runs on — used for CORS and Better Auth's
	// trustedOrigins/crossSubDomainCookies.
	WEB_ORIGIN: z.string().url(),
	COOKIE_DOMAIN: z.string().min(1),
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
	return parsed.data;
}

export const env = loadEnv();
