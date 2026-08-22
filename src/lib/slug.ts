/**
 * Slug validation shared by /api/slug/check and the deploy/rename routes.
 * The DB's unique index on Site.slug is what actually wins races between
 * two concurrent claims — this is the fast, friendly rejection layer.
 */

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;

const RESERVED_SLUGS = new Set([
	"www",
	"api",
	"app",
	"admin",
	"mail",
	"ftp",
	"blog",
	"docs",
	"cdn",
	"static",
	"assets",
	"dashboard",
	"auth",
	"login",
	"signup",
	"help",
	"support",
	"status",
	"dev",
	"staging",
	"test",
	"root",
	"ns1",
	"ns2",
	"smtp",
	"imap",
	"webmail",
]);

export type SlugValidationError =
	| "too_short"
	| "too_long"
	| "invalid_format"
	| "reserved"
	| "punycode_like";

export function validateSlug(slug: string): SlugValidationError | null {
	if (slug.length < 3) return "too_short";
	if (slug.length > 63) return "too_long";
	if (!SLUG_PATTERN.test(slug)) return "invalid_format";
	if (RESERVED_SLUGS.has(slug)) return "reserved";
	// Reject xn--/punycode-style ACE prefixes at the position where they'd
	// be interpreted as such by a resolver, to avoid IDN homograph tricks.
	if (slug.slice(2, 4) === "--") return "punycode_like";
	return null;
}

export function isValidSlug(slug: string): boolean {
	return validateSlug(slug) === null;
}
