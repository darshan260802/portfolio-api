import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { Resend } from "resend";
import { env } from "../env.js";
import { prisma } from "./prisma.js";

const resend = new Resend(env.RESEND_API_KEY);

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
			await resend.emails.send({
				from: env.EMAIL_FROM,
				to: user.email,
				subject: "Reset your Portfolio Builder password",
				html: `<p>Reset your password:</p><p><a href="${url}">${url}</a></p><p>If you didn't request this, ignore this email.</p>`,
			});
		},
	},
	emailVerification: {
		sendOnSignUp: true,
		autoSignInAfterVerification: true,
		sendVerificationEmail: async ({ user, url }) => {
			await resend.emails.send({
				from: env.EMAIL_FROM,
				to: user.email,
				subject: "Verify your email for Portfolio Builder",
				html: `<p>Verify your email:</p><p><a href="${url}">${url}</a></p>`,
			});
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
