import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env.js";
import { auth } from "./lib/auth.js";
import type { AppEnv } from "./middleware.js";
import { deployRoute } from "./routes/deploy.js";
import { exportRoute } from "./routes/export.js";
import { profileRoute } from "./routes/profile.js";
import { slugRoute } from "./routes/slug.js";
import { templatesRoute } from "./routes/templates.js";
import { uploadsRoute } from "./routes/uploads.js";
import { reapOrphanedBuilds } from "./services/builder.service.js";

const app = new Hono<AppEnv>();

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
	console.error("[api] unhandled error:", err);
	return c.json({ error: "internal_error" }, 500);
});

await reapOrphanedBuilds();

console.log(`[api] listening on :${env.PORT} (${env.NODE_ENV})`);

export default {
	port: env.PORT,
	fetch: app.fetch,
};
