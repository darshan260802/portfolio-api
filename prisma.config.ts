import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// The running app's PrismaClient uses the PrismaPg adapter (see
// src/lib/prisma.ts) against the Supavisor transaction pooler
// (DATABASE_URL). This file is only what the Prisma CLI itself uses —
// generate/migrate/studio — and points at the DIRECT connection, since
// migrations need a real session rather than a transaction-mode pooler.
export default defineConfig({
	schema: "prisma/schema.prisma",
	migrations: {
		path: "prisma/migrations",
	},
	datasource: {
		url: env("DIRECT_URL"),
	},
});
