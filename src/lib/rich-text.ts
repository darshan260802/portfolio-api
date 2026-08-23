import sanitizeHtml from "sanitize-html";
import type { PortfolioData } from "@pb/templates";

/**
 * Sanitizes profile.bio / experience.summary / project.description before
 * they're ever persisted — this is the ONLY place user-authored rich text
 * enters the system (PUT /api/me/profile), so it's also the only place
 * that needs to sanitize it. Every downstream reader (the wizard's own
 * live preview, ZIP export, the hosted build) renders whatever's already
 * in the database via dangerouslySetInnerHTML, trusting it was cleaned
 * here first.
 *
 * The allowlist matches exactly what the wizard's TipTap editor can
 * produce — bold, italic, links, two list types — nothing else. No
 * `<img>`: this feature has no image upload/storage path, so an image tag
 * could only arrive via someone bypassing the editor UI entirely, which is
 * exactly the case this exists to guard against.
 */
const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: ["p", "br", "strong", "b", "em", "i", "ul", "ol", "li", "a"],
	allowedAttributes: {
		a: ["href", "target", "rel"],
	},
	allowedSchemes: ["http", "https", "mailto"],
	// Force every link to open safely regardless of what the client sent —
	// belt-and-suspenders alongside the editor's own HTMLAttributes config.
	transformTags: {
		a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
	},
};

export function sanitizeRichText(html: string | undefined): string | undefined {
	if (!html) return html;
	const clean = sanitizeHtml(html, RICH_TEXT_OPTIONS).trim();
	return clean.length > 0 ? clean : undefined;
}

/** Runs sanitizeRichText over the three rich-text fields anywhere in a PortfolioData object. */
export function sanitizePortfolioData(data: PortfolioData): PortfolioData {
	return {
		...data,
		profile: { ...data.profile, bio: sanitizeRichText(data.profile.bio) },
		experience: data.experience?.map((item) => ({ ...item, summary: sanitizeRichText(item.summary) })),
		projects: data.projects?.map((item) => ({ ...item, description: sanitizeRichText(item.description) })),
	};
}
