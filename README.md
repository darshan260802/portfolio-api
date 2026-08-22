# portfolio-builder-api

Hono on Bun. Auth (Better Auth), profile storage, template gallery, ZIP
export, and the hosting build/publish pipeline.

## Setup

```sh
bun install
cp .env.example .env   # fill in real values
bunx --bun prisma generate
bunx --bun prisma migrate dev   # against DIRECT_URL, see prisma.config.ts
bun run dev
```

`@pb/templates` is a `file:../portfolio-builder-templates` dependency for
local development (both repos are siblings on disk). Once
`portfolio-builder-templates` is pushed to GitHub, switch it to a `github:`
dependency in `package.json` for CI/production — `bun install` does not run
`dist/`'s build step for git dependencies (see that repo's README), so its
`dist/` must already be committed there.

`TEMPLATES_DIR` must point at a checkout of `portfolio-builder-templates`
where `bun run build && bun run prewarm` have already run — the build
pipeline reads template source and prewarmed `node_modules` straight off
disk, not through the npm-style package install.

## Prisma 7 notes

This uses the `prisma-client` generator (TS query compiler, no Rust engine
binary) with `@prisma/adapter-pg`. Connection config is split two ways:

- **Runtime** (`src/lib/prisma.ts`): `PrismaPg` adapter against
  `DATABASE_URL` — the Supavisor **transaction pooler** (port 6543,
  `?pgbouncer=true&connection_limit=1`).
- **CLI** (`prisma.config.ts`, used by `generate`/`migrate`/`studio`):
  `DIRECT_URL` — the **direct** connection (port 5432). Migrations need a
  real session, not a transaction-mode pooler.

`schema.prisma`'s `datasource` block intentionally has no `url`/`directUrl`
— Prisma 7 removed those in favor of `prisma.config.ts`.

## Build/publish pipeline

`POST /api/deploy` queues a `Deployment` row (`src/services/queue.service.ts`,
concurrency-capped in-process). Each job (`src/services/builder.service.ts`):

1. Materializes a real Vite project (`scaffold.service.ts`): scaffold shell
   + this template's source + `data.json`.
2. Downloads any Supabase Storage assets referenced in the data into
   `public/assets/` (`assets.service.ts`) so the output is self-contained.
3. Hardlink-copies (`cp -al`) that template's prewarmed `node_modules` in —
   never symlinked; Vite realpaths through symlinks by default, which can
   resolve React outside the build root.
4. Spawns the Vite binary directly via `Bun.spawn` (never `bun x`/`bun run`
   — a shell wrapper survives SIGTERM and orphans the real build).
5. Publishes (`hosting.service.ts`): copies `dist/` into
   `.releases/<slug>/<deploymentId>/`, rewrites the `%%SITE_URL%%`
   placeholder left in the HTML by the build, then atomically repoints the
   `PORTFOLIOS_DIR/<slug>` symlink at it (symlink-to-temp-name +
   `rename()` — plain `ln -sfn` is not atomic).

A slug rename only ever touches the publish step (the placeholder rewrite),
never a rebuild. See the design doc's "Resolved implementation mechanics"
section for the full reasoning and the bugs this avoids.

## Known gap

Full server boot (Better Auth + Prisma against a live Postgres) has not
been exercised in this environment — there's no local Postgres/Docker
available here. Everything up to that boundary is verified: the module
graph type-checks cleanly end to end, and the build→publish→rename→
unpublish pipeline was run for real against the templates repo's Aurora
template. Point `DATABASE_URL`/`DIRECT_URL` at a real (or local) Postgres
and run `prisma migrate dev` before the first `bun run dev`.
