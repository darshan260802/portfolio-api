/**
 * Baked into a hosted build's canonical/og:url in place of the real URL,
 * then string-replaced with the real one at publish time — so a slug
 * rename only touches the publish step, never triggers a rebuild.
 * See the design doc's "Resolved implementation mechanics" #8.
 */
export const SITE_URL_PLACEHOLDER = "%%SITE_URL%%";
