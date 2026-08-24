import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { env } from "../env.js";
import { log } from "./logger.js";
import { sendMail } from "./mailer.js";
import { prisma } from "./prisma.js";

const authLog = log.child("auth");

/**
 * Better Auth builds the verification link's `callbackURL` from the client's
 * request body and falls back to a bare "/" (see sign-up, sign-in and
 * send-verification-email in better-auth/api/routes). At verify time it
 * redirects to that value verbatim, so a relative "/" resolves against the
 * API's own origin and strands the user on the API root instead of the web
 * app. There is no server-side option for a default, but we own the link
 * before it's mailed — so anchor a relative callback to WEB_ORIGIN here.
 * A client that asked for an absolute destination keeps it (Better Auth
 * still origin-checks it against trustedOrigins).
 */
export function toWebAppCallbackURL(verificationUrl: string, webOrigin: string): string {
	const url = new URL(verificationUrl);
	const callback = url.searchParams.get("callbackURL");
	if (!callback) return verificationUrl;
	let absolute: URL;
	try {
		absolute = new URL(callback, webOrigin);
	} catch {
		// Garbage callback from the client: leave it as-is and let Better
		// Auth's origin check reject it, rather than failing the send.
		return verificationUrl;
	}
	url.searchParams.set("callbackURL", absolute.toString());
	return url.toString();
}

/**
 * Cross-subdomain cookies: COOKIE_DOMAIN must be the leading-dot PARENT
 * domain (".ourapp.com"), not the web app's own host — that's what lets a
 * session cookie set by the API on api.ourapp.com be read by the browser
 * on app.ourapp.com. SameSite=Lax + Secure is sufficient for this (same
 * registrable site, different subdomain); no need for SameSite=None.
 * See the design doc's "Resolved implementation mechanics" #12.
 */
export const auth = betterAuth({
	database: prismaAdapter(prisma, { provider: "postgresql" }),
	secret: env.BETTER_AUTH_SECRET,
	baseURL: env.BETTER_AUTH_URL,
	trustedOrigins: [env.WEB_ORIGIN],
	advanced: {
		crossSubDomainCookies: {
			enabled: true,
			domain: env.COOKIE_DOMAIN,
		},
	},
	emailAndPassword: {
		enabled: true,
		requireEmailVerification: true,
		sendResetPassword: async ({ user, url }) => {
			authLog.info("sending password reset email", { userId: user.id, email: user.email });
			try {
				await sendMail({
					to: user.email,
					subject: "Reset your Portfolio Builder password",
					html: `<p>Reset your password:</p><p><a href="${url}">${url}</a></p><p>If you didn't request this, ignore this email.</p>`,
				});
			} catch (err) {
				authLog.error("password reset email failed", { userId: user.id, email: user.email, err });
				throw err;
			}
		},
	},
	emailVerification: {
		sendOnSignUp: true,
		autoSignInAfterVerification: true,
		sendVerificationEmail: async ({ user, url }) => {
			const link = toWebAppCallbackURL(url, env.WEB_ORIGIN);
			authLog.info("sending verification email", { userId: user.id, email: user.email });
			try {
				await sendMail({
					to: user.email,
					subject: "Verify your email for Portfolio Builder",
					html: `<p>Verify your email:</p><p><a href="${link}">${link}</a></p>`,
				});
			} catch (err) {
				authLog.error("verification email failed", { userId: user.id, email: user.email, err });
				throw err;
			}
		},
	},
	socialProviders: {
		google: {
			clientId: env.GOOGLE_CLIENT_ID,
			clientSecret: env.GOOGLE_CLIENT_SECRET,
		},
		github: {
			clientId: env.GITHUB_CLIENT_ID,
			clientSecret: env.GITHUB_CLIENT_SECRET,
		},
	},
});

export type Session = typeof auth.$Infer.Session;
