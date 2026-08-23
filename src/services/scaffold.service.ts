import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PortfolioData } from "@pb/templates";
import { env } from "../env.js";
import { log } from "../lib/logger.js";
import { renderPlaceholders } from "../lib/template-string.js";

const scaffoldLog = log.child("scaffold");

export interface MaterializeOptions {
	/** Absolute path to an empty directory to materialize the project into. */
	targetDir: string;
	templateId: string;
	data: PortfolioData;
	projectName: string;
	siteTitle: string;
	siteDescription: string;
	siteUrl: string;
	siteOgImage: string;
	/** A `data:image/svg+xml;base64,...` URI — see lib/favicon.ts. */
	siteFavicon: string;
}

const scaffoldDir = () => join(env.TEMPLATES_DIR, "scaffold");
const templateSrcDir = (id: string) => join(env.TEMPLATES_DIR, "src/templates", id);

/**
 * Builds a real, standalone Vite + React project into `targetDir`:
 * scaffold shell + this template's source + this user's data.json.
 * No node_modules, no build — that's the caller's job (zip.service ships
 * source as-is; builder.service adds prewarmed deps and runs `vite build`).
 *
 * schema.ts is copied defensively even though every current template only
 * uses it via `import type` (which Vite/esbuild elide before module
 * resolution, so the file is never actually needed at build time today) —
 * a future template that imports a runtime value from it should just work
 * without this function changing.
 *
 * rich-text.tsx is NOT defensive — every template's sections/*.tsx imports
 * `RichText` from it at runtime (three levels up from
 * src/templates/<id>/sections/, i.e. "../../../rich-text.js"), so omitting
 * it here breaks every materialized build (zip export and hosted deploy
 * alike) with an unresolved import.
 */
export function materializeProject(opts: MaterializeOptions): void {
	const { targetDir } = opts;
	mkdirSync(join(targetDir, "src"), { recursive: true });

	cpSync(join(scaffoldDir(), "vite.config.ts"), join(targetDir, "vite.config.ts"));
	cpSync(join(scaffoldDir(), "tsconfig.json"), join(targetDir, "tsconfig.json"));

	const vars: Record<string, string> = {
		PROJECT_NAME: opts.projectName,
		SITE_TITLE: opts.siteTitle,
		SITE_DESCRIPTION: opts.siteDescription,
		SITE_URL: opts.siteUrl,
		SITE_OG_IMAGE: opts.siteOgImage,
		SITE_FAVICON: opts.siteFavicon,
		TEMPLATE_ID: opts.templateId,
		ORG: "REPLACE_ORG",
	};

	writePlaceholderFile(join(scaffoldDir(), "package.json.tmpl"), join(targetDir, "package.json"), vars);
	writePlaceholderFile(join(scaffoldDir(), "index.html.tmpl"), join(targetDir, "index.html"), vars);
	writePlaceholderFile(join(scaffoldDir(), "README.md.tmpl"), join(targetDir, "README.md"), vars);
	writePlaceholderFile(
		join(scaffoldDir(), "src/main.tsx.tmpl"),
		join(targetDir, "src/main.tsx"),
		vars,
	);

	cpSync(join(env.TEMPLATES_DIR, "src/schema.ts"), join(targetDir, "src/schema.ts"));
	cpSync(join(env.TEMPLATES_DIR, "src/rich-text.tsx"), join(targetDir, "src/rich-text.tsx"));
	cpSync(templateSrcDir(opts.templateId), join(targetDir, "src/templates", opts.templateId), {
		recursive: true,
	});

	writeFileSync(join(targetDir, "src/data.json"), JSON.stringify(opts.data, null, 2));

	scaffoldLog.debug("materialized project", { targetDir, templateId: opts.templateId, projectName: opts.projectName });
}

function writePlaceholderFile(srcPath: string, destPath: string, vars: Record<string, string>): void {
	const contents = readFileSync(srcPath, "utf8");
	writeFileSync(destPath, renderPlaceholders(contents, vars));
}
