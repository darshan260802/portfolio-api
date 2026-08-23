import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env.js";
import { auth } from "./lib/auth.js";
import { log } from "./lib/logger.js";
import type { AppEnv } from "./middleware.js";
import { requestLogger } from "./middleware.js";
import { deployRoute } from "./routes/deploy.js";
import { exportRoute } from "./routes/export.js";
import { profileRoute } from "./routes/profile.js";
import { slugRoute } from "./routes/slug.js";
import { templatesRoute } from "./routes/templates.js";
import { uploadsRoute } from "./routes/uploads.js";
import { reapOrphanedBuilds } from "./services/builder.service.js";

const app = new Hono<AppEnv>();

// First middleware in the chain: every request is logged even if it fails
// CORS or auth. See middleware.ts.
app.use("*", requestLogger);

// CORS registered before the auth route, explicit origin (never "*"),
// credentials: true — required for cross-subdomain cookies to work at all.
// See the design doc's "Resolved implementation mechanics" #12.
app.use(
	"*",
	cors({
		origin: env.WEB_ORIGIN,
		credentials: true,
		allowHeaders: ["Content-Type"],
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	}),
);

app.on(["POST", "GET"], "/api/auth/**", (c) => auth.handler(c.req.raw));

app.route("/api/templates", templatesRoute);
app.route("/api/me/profile", profileRoute);
app.route("/api/slug", slugRoute);
app.route("/api/export", exportRoute);
app.route("/api/uploads", uploadsRoute);
app.route("/api", deployRoute); // /api/deploy, /api/deployments/:id, /api/me/site/slug

app.get("/healthz", (c) => c.text("ok"));

app.onError((err, c) => {
	// requestLogger (mounted first, above) always sets "log" before any
	// route can throw — the root logger is just a defensive fallback.
	const errLog = c.get("log") ?? log.child("http");
	errLog.error("unhandled error", { err, path: c.req.path, method: c.req.method });
	return c.json({ error: "internal_error" }, 500);
});

await reapOrphanedBuilds();

log.child("boot").info(`listening on :${env.PORT}`, { nodeEnv: env.NODE_ENV, port: env.PORT });

export default {
	port: env.PORT,
	fetch: app.fetch,
};
