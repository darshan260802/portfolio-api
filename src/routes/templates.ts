import { Hono } from "hono";
import { TEMPLATES } from "@pb/templates";
import type { AppEnv } from "../middleware.js";

export const templatesRoute = new Hono<AppEnv>();

templatesRoute.get("/", (c) => {
	c.get("log")?.debug("list templates", { count: TEMPLATES.length });
	return c.json({ templates: TEMPLATES });
});
