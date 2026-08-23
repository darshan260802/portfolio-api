/**
 * Generates a favicon for a materialized site: a rounded square in a color
 * derived from the name, with the owner's initials centered on it. Every
 * hosted/exported portfolio gets one automatically — there's no upload flow
 * for a custom favicon, and shipping no favicon at all just shows the
 * browser's default globe/blank icon for every deployed site.
 */

const PALETTE = ["#863bff", "#2563eb", "#059669", "#d97706", "#dc2626", "#0891b2", "#c026d3"];

function initialsFor(fullName: string): string {
	const words = fullName.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
	return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

function colorFor(seed: string): string {
	let hash = 0;
	for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
	return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

/** A name can contain anything (unicode, quotes, "&") — escape before embedding in the SVG's XML. */
function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Returns a `data:image/svg+xml;base64,...` URI — safe to drop directly into an `href` attribute. */
export function initialsFaviconDataUri(fullName: string): string {
	const initials = escapeXml(initialsFor(fullName));
	const background = colorFor(fullName || "?");
	const fontSize = initials.length > 1 ? 30 : 36;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${background}"/><text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="600" fill="#ffffff">${initials}</text></svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
