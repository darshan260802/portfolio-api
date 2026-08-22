import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { env } from "../env.js";

// connection_limit is also set via the DATABASE_URL query string
// (?pgbouncer=true&connection_limit=1) — Supavisor's transaction-mode
// pooler has a small connection budget shared across every API instance,
// and concurrent builds are exactly the kind of load that can exhaust it.
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });
