# Portfolio Builder — API

Hono on Bun. Auth, profile storage, template gallery, ZIP export, and
the hosting build/publish pipeline behind
[`portfolio-builder-ui`](https://github.com/darshan260802/portfolio-ui).

<p align="center">
  <img src="docs/screenshots/wizard.png" alt="The wizard writing to /api/me/profile with live preview." width="900" />
</p>

Runs one process. Every request routes through Hono, sessions come from
Better Auth (Prisma adapter, cross-subdomain cookies), the build queue
is in-process, and published sites live behind an nginx that resolves
`<slug>.<domain>/` to a symlink this API owns.

---

## What it does

- **Serves the builder app** — templates, profile CRUD, slug lookup,
  auth (Google, GitHub, email + password with real reset flows via
  Resend).
- **Runs the build/publish pipeline** — takes one wizard's worth of
  data, spawns a real Vite build for the picked template, and atomically
  publishes the result at `<slug>.<domain>`.
- **Hosts the user's own project instead** — give it a public git repo,
  a Bun install/build command and the folder the build writes into, and
  it clones, builds, publishes the output at the same `<slug>.<domain>`
  and deletes the checkout. Build-time environment variables are stored
  encrypted. See [Hosting a user's own repository](#hosting-a-users-own-repository).
- **Provides the ZIP export** — same materialized project the hosted
  build uses, streamed as an archive so the user gets a working Vite +
  React repo (no lock-in).
- **Enforces "one portfolio per account"** — publishing over an
  existing site is fine; asking for a *second* subdomain returns
  `409 site_exists` naming what the account already owns.

## Feature highlights

| Feature | What it does | Why it exists |
|---|---|---|
| **Materialize → Vite build → publish** | For every deploy, scaffolds a real Vite + React project (template source + user data.json + rewritten placeholders), hardlink-copies prewarmed `node_modules`, spawns Vite via `Bun.spawn` (never through a shell wrapper), and copies `dist/` into `.releases/<slug>/<deploymentId>/`. | Real Vite output means every build is production-quality; hardlink (`cp -al`) instead of symlink prevents Vite realpath from resolving React outside the build root. |
| **Bring-your-own-repo builds** | `POST /api/deploy` with `source: "GIT"` clones a public repo (`git clone --depth 1 --single-branch`), runs the user's install and build commands as **argv, never through a shell**, and publishes their build folder through the same release/symlink path a template build uses. The subprocesses get a constructed environment — not `process.env` — plus the user's own variables. | Building someone else's code is arbitrary code execution; the mitigations that matter are the ones that keep the *inputs* honest (a host allowlist, no shell, no inherited secrets, a budget per step) rather than pretending the build is safe. |
| **User env vars encrypted at rest** | `site_env_var.value_cipher` is AES-256-GCM over a key derived by HKDF from `SITE_ENV_SECRET` (or `BETTER_AUTH_SECRET`, with a distinct `info` string). The API returns key *names* only — never a value, on any endpoint. | These are the user's own API tokens and we have to be able to read them back, so hashing isn't an option. Authenticated encryption also means a row edited in the database fails to decrypt instead of silently injecting a different value into someone's build. |
| **Atomic slug symlink** | Publishing writes a temp-named symlink and `rename(2)`s it over `PORTFOLIOS_DIR/<slug>`. Slug renames point the new name at the current release *before* the DB row moves, so there's never a 404 window. | Plain `ln -sfn` is unlink-then-symlink — leaves a real gap where the site 404s. |
| **Slug rename without rebuild** | Site URL is written to HTML as a `%%SITE_URL%%` placeholder; publish rewrites it. Renames only touch the placeholder and the symlink. | Renaming is instant; the build only happens on real content changes. |
| **Concurrency-capped build queue** | In-process queue caps concurrent builds (`MAX_CONCURRENT_BUILDS`), enforces `BUILD_TIMEOUT_MS`, and SIGKILLs on timeout. Orphaned `BUILDING` deployments are reaped on boot. | One process = simple ops; the cap keeps a burst of deploys from starving the machine. |
| **Rich-text sanitization at the boundary** | `PUT /api/me/profile` sanitizes `profile.bio`, `experience.summary`, and `project.description` with a strict allowlist (bold, italic, links, two list types) before persisting. | Every downstream reader (live preview, ZIP export, hosted build) can trust what's already in the database. |
| **Uploads validated on the bytes** | `POST /api/uploads/:kind` (profile photo, résumé) takes the file through the API instead of handing out a signed URL, caps it at 5 MB, and decides the format by sniffing magic bytes — `%PDF-`, the PNG/JPEG/WebP headers, and for `.docx` the ZIP header **plus** a `word/document.xml` entry. The stored object's extension and content type come from what the bytes are, never from what the upload claimed. | A signed upload URL carries no size or type constraint, and a résumé is served to every visitor of a published portfolio — "the browser said it was a PDF" isn't a good enough answer for what it is. A renamed `.zip` passes a ZIP-header check; it doesn't pass this one. |
| **Superseded uploads collected on replace** | After a successful upload the API prunes the account's older objects of that kind, keeping the new one **and** whichever one the saved profile still points at. | The client hasn't written the new URL yet at that moment. Deleting the still-referenced object would leave anyone who closes the tab mid-edit with a portfolio pointing at a 404. |
| **Cross-subdomain sessions** | Better Auth `crossSubDomainCookies` + explicit `Access-Control-Allow-Credentials`. | The builder at `app.<domain>` and every user site at `<slug>.<domain>` share the same auth story cleanly. |
| **Single-portfolio guard** | `Site.userId` is unique; `POST /api/deploy` rejects a mismatched `slug` with `409 site_exists` instead of silently overwriting. | Aligns the API with the UI's overwrite confirm — no more silent "publish → surprise, my other site is gone". |

## Who it's for

- Anyone hosting the whole Portfolio Builder stack.
- People curious about a real build-and-publish pipeline that avoids
  the usual footguns — Bun spawn semantics, React realpath resolution,
  atomic publishing, symlink races.

## What it looks like (from the user's side)

<table>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/wizard.png" alt="The wizard PUT-ing to /api/me/profile every step." />
      <p align="center"><em>The wizard writes to <code>PUT /api/me/profile</code> every step; every rich-text field is sanitized here.</em></p>
    </td>
    <td width="50%">
      <img src="docs/screenshots/settings.png" alt="Settings — subdomain rename, appearance toggle, template switch." />
      <p align="center"><em>Settings actions each go through this API — rename (<code>PATCH /me/site/slug</code>), redeploy (<code>POST /deploy</code>).</em></p>
    </td>
  </tr>
</table>

---

## Setup

```sh
bun install
cp .env.example .env   # fill in real values
bunx --bun prisma generate
bunx --bun prisma migrate dev   # against DIRECT_URL, see prisma.config.ts
bun run dev
```

`@pb/templates` ships as a `github:` dependency from
[`portfolio-templates`](https://github.com/darshan260802/portfolio-templates)
with its `dist/` committed, so `bun install` doesn't run a build.

`TEMPLATES_DIR` must point at a checkout of `portfolio-templates` where
`bun run build && bun run prewarm` have already run — the build pipeline
reads template source and prewarmed `node_modules` straight off disk,
not through the npm-style package install.

## Environment

Full list in `.env.example`. The ones you can't skip:

| Var | What it is |
|---|---|
| `DATABASE_URL` | Supavisor **transaction pooler** (port 6543, `?pgbouncer=true&connection_limit=1`). Used at runtime. |
| `DIRECT_URL` | Direct Postgres (port 5432). Used only by `prisma migrate`. |
| `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` | Auth signing + canonical URL. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | OAuth. |
| `RESEND_API_KEY` / `EMAIL_FROM` | Password reset emails. `env.ts` refuses `@resend.dev` in `NODE_ENV=production` — that shared sender only delivers to the Resend account owner. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_BUCKET` | Signed upload URLs for user avatars/project images. |
| `TEMPLATES_DIR` / `PORTFOLIOS_DIR` / `BUILD_TMP_DIR` | Absolute paths; see below. |
| `PORTFOLIO_DOMAIN` | e.g. `ourapp.com`. Sites publish at `<slug>.<PORTFOLIO_DOMAIN>`. |
| `GIT_ALLOWED_HOSTS` | Hosts a user's repo may be cloned from. Defaults to github.com, gitlab.com, bitbucket.org, codeberg.org. This is the SSRF boundary — see below. |
| `SITE_ENV_SECRET` | Optional. Encrypts users' build-time env vars; derived from `BETTER_AUTH_SECRET` when unset. |
| `WEB_ORIGIN` / `COOKIE_DOMAIN` | For CORS + cross-subdomain cookies. |
| `NOTIFY_WEBHOOK_URL` / `NOTIFY_WEBHOOK_SECRET` | Optional. Where portfolio lifecycle events are POSTed, and the secret they're signed with. Unset ⇒ no notifications are sent. See [Notification webhook](#notification-webhook). |

## Prisma 7 notes

Uses the `prisma-client` generator (TS query compiler, no Rust engine
binary) with `@prisma/adapter-pg`. Connection config is split two ways:

- **Runtime** (`src/lib/prisma.ts`): `PrismaPg` adapter against
  `DATABASE_URL` — the Supavisor **transaction pooler**.
- **CLI** (`prisma.config.ts`, used by `generate`/`migrate`/`studio`):
  `DIRECT_URL` — direct Postgres (port 5432). Migrations need a real
  session, not a transaction-mode pooler.

`schema.prisma`'s `datasource` block intentionally has no
`url`/`directUrl` — Prisma 7 removed those in favor of
`prisma.config.ts`.

## Build/publish pipeline

`POST /api/deploy` queues a `Deployment` row
(`src/services/queue.service.ts`, concurrency-capped in-process).
`builder.service.ts` then dispatches on `Site.source`: `TEMPLATE` runs the
pipeline below, `GIT` runs the one in
[Hosting a user's own repository](#hosting-a-users-own-repository). Both
end at the same `publish()`. For a template job:

1. Materializes a real Vite project (`scaffold.service.ts`): scaffold
   shell + this template's source + `data.json`. It also copies the
   templates repo's `src/rich-text.tsx`, `src/uploads.ts` and
   `src/schema.ts` — every template's sections import runtime values from
   the first two (`RichText`, `resumeDownload`), so leaving either out
   fails the build on an unresolved import rather than degrading.
2. Downloads any Supabase Storage assets referenced in the data into
   `public/assets/` (`assets.service.ts`) so the output is
   self-contained.
3. Hardlink-copies (`cp -al`) that template's prewarmed `node_modules`
   in — never symlinked; Vite realpaths through symlinks by default,
   which can resolve React outside the build root.
4. Spawns the Vite binary directly via `Bun.spawn` (never `bun x`/`bun
   run` — a shell wrapper survives SIGTERM and orphans the real build).
   SIGKILL on timeout because SIGTERM may not stop a wedged native
   Rolldown thread.
5. Publishes (`hosting.service.ts`): copies `dist/` into
   `.releases/<slug>/<deploymentId>/`, rewrites the `%%SITE_URL%%`
   placeholder left in the HTML by the build, then atomically repoints
   the `PORTFOLIOS_DIR/<slug>` symlink at it (symlink-to-temp-name +
   `rename()` — plain `ln -sfn` is not atomic).

A slug rename only ever touches the publish step (the placeholder
rewrite), never a rebuild.

## Notification webhook

Set `NOTIFY_WEBHOOK_URL` and the API POSTs one JSON body to it every time
something happens to a portfolio — most importantly when a build finishes
and a site goes live. Delivery is entirely out of band
(`src/services/webhook.service.ts`): it never blocks a request, never
slows a build down, and a dead endpoint can never fail a publish; failures
are logged under the `webhook` scope and nowhere else. Leave the var unset
and every `notify()` is a no-op, so nothing changes locally.

**Events**

| `event` | When |
|---|---|
| `profile.template_changed` | The wizard saved a *different* template than before (fires on the change only, not on every autosave). |
| `site.created` | A user claimed a subdomain — their portfolio now exists. |
| `site.template_changed` | A publish switched the live site to another template. |
| `site.slug_changed` | The subdomain was renamed (`live: true` when it was already serving). |
| `site.published` | A build succeeded and the site is live at `url`. |
| `site.publish_failed` | A build failed. `reason` is one of `no_profile`, `build_failed`, `build_timeout`, `internal_error`. |

**Body** — always the same envelope; `data` varies per event:

```jsonc
{
  "id": "0f9a…",                       // unique per delivery — use it to dedupe
  "event": "site.published",
  "occurredAt": "2026-01-31T10:04:11.812Z",
  "data": {
    "deploymentId": "clx…",
    "siteId": "clx…",
    "slug": "jane",
    "templateId": "aurora",
    "url": "https://jane.ourapp.com/",
    "isFirstPublish": true,            // false on a republish
    "durationMs": 18422,
    "user": { "id": "clx…", "email": "jane@example.com", "name": "Jane" }
  }
}
```

**Headers**

| Header | Value |
|---|---|
| `x-pb-event` | The event name, so you can route without parsing the body. |
| `x-pb-delivery` | Same as `data`'s `id`. Retries reuse it — dedupe on it. |
| `x-pb-timestamp` | Unix seconds. Reject anything too old to blunt replays. |
| `x-pb-signature` | `sha256=<hex>` — only when `NOTIFY_WEBHOOK_SECRET` is set. |

**Verifying** (compute over the **raw** body, before any JSON parsing):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const expected = `sha256=${createHmac("sha256", process.env.NOTIFY_WEBHOOK_SECRET)
  .update(`${req.headers["x-pb-timestamp"]}.${rawBody}`)
  .digest("hex")}`;

const received = req.headers["x-pb-signature"] ?? "";
const ok =
  received.length === expected.length &&
  timingSafeEqual(Buffer.from(received), Buffer.from(expected));
```

**Retries** — up to 3 attempts (500ms, then 1s) on a network error, a
timeout (`NOTIFY_WEBHOOK_TIMEOUT_MS`, default 5s), `429`, or any `5xx`.
Other `4xx` responses are taken as a deliberate rejection and not
retried. Answer `2xx` as soon as you've accepted the delivery and do the
slow part afterwards.

## Routes

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /api/templates` | public | Lists template manifests from `@pb/templates`. |
| `GET /api/me/profile` | ✓ | Reads the account's profile (`{ templateId, data, updatedAt }`). |
| `PUT /api/me/profile` | ✓ | Replaces the profile. Zod-validated with the shared schema; rich-text sanitized. |
| `GET /api/me/site` | ✓ | Current site (slug, template, status, url). |
| `POST /api/deploy` | ✓ | Queues a build from a template or from the user's repo (`source`/`git` in the body). Rejects a second subdomain (`409 site_exists`). |
| `GET /api/deployments/:id` | ✓ | Poll for status/log. |
| `PUT /api/me/site/git` | ✓ | Saves the repo config (URL, branch, commands, build folder, env vars) **without** building. |
| `PATCH /api/me/site/slug` | ✓ | Rename. Two-phase symlink swap when live. |
| `GET /api/slug/check?slug=…` | public | Availability + reason code. |
| `POST /api/uploads` | ✓ | Signed Supabase upload URL scoped to the user. Project images only. |
| `POST /api/uploads/:kind` | ✓ | `avatar` \| `resume`. Multipart (`file`), validated and stored server-side; returns `{ url, filename, contentType, size }`. |
| `DELETE /api/uploads/:kind` | ✓ | Removes the account's stored files of that kind. Call it *after* saving the cleared profile. |
| `POST /api/export/zip` | ✓ | Streams a ZIP of the materialized project. |
| `POST /api/auth/**` | — | Better Auth handler. |

## Hosting a user's own repository

The alternative to picking a template. `POST /api/deploy` with
`source: "GIT"` (or a `git` object, which implies it) runs a second
pipeline in `services/git-build.service.ts`:

1. `git clone --depth 1 --single-branch --no-tags` the normalized repo URL.
2. Size-check the checkout against `GIT_MAX_REPO_MB` — **before** a single
   dependency is fetched.
3. Run the install command, then the build command, each as an argv array
   with its own timeout.
4. Resolve the build folder against the checkout's *real* path, require an
   `index.html`, and hand it to the same `publish()` a template build uses —
   so the output lands in `.releases/<slug>/<deploymentId>/` behind the
   atomic `PORTFOLIOS_DIR/<slug>` symlink.
5. Delete the checkout in `finally`, successful or not.

A site keeps its `templateId` while it's repo-backed, so switching back to
a template (or back to the repo) is one request either way, with nothing
re-entered.

### What's actually enforced

Running a stranger's build script is arbitrary code execution by
definition. Nothing here pretends otherwise; what it does is keep the
*inputs* honest, so what runs is the repository's own build and not
something smuggled through a field that was only supposed to name one.
`lib/git-source.ts` is the single place all of it lives:

| Guard | Why |
|---|---|
| **Host allowlist** (`GIT_ALLOWED_HOSTS`), https only, no credentials in the URL, no port, `owner/repo`-shaped path | Without it `git clone` is an SSRF primitive: `https://169.254.169.254/…` or an internal git server would be fetched by our box and echoed back through the build log. |
| **Commands parsed to argv, `bun`/`bunx` only; shell operators (semicolon, ampersand, pipe, redirects, backtick, dollar, backslash) rejected** | The command never reaches a shell — it's spawned as an argv array — so there is nothing for a `;` to break out of, and no shell to add later by accident. |
| **A constructed environment, not `process.env`** | The template build inherits ours because it runs our code. This one must not: our env holds `DATABASE_URL`, `BETTER_AUTH_SECRET` and `SUPABASE_SERVICE_ROLE_KEY`, and a build script can print anything it can read. |
| **Reserved env names** (`PATH`, `HOME`, `NODE_OPTIONS`, `LD_PRELOAD`, `BUN_*`, `GIT_*`, `npm_*`, …) | A variable that redirects the interpreter or the registry isn't configuring a site. The toolchain's own wiring is re-applied after the user's variables so it wins regardless. |
| **Build folder is a repo subpath, realpath-checked, `index.html` required** | `..` is rejected up front, but a *committed symlink* (`dist -> /etc`) is checked by neither — realpath and containment are what stop the host's filesystem being served on someone's subdomain. The repository root is rejected too: publishing it would put `.git` and `node_modules` on the public web. |
| **Per-step timeouts, SIGKILL, size cap** | Same reasoning as the template pipeline: SIGTERM doesn't reliably stop a wedged native build thread. |

These are the boundaries this process can draw. **Run the API where a
runaway build can't hurt anything else** — a container or VM with its own
CPU/memory/disk limits — because that boundary is the one that actually
contains a build, and this code can't provide it for itself.

### Environment variables

`SiteEnvVar.valueCipher` holds AES-256-GCM ciphertext (`lib/secret-box.ts`),
keyed by HKDF-SHA256 over `SITE_ENV_SECRET` — or `BETTER_AUTH_SECRET` when
that's unset, with a feature-specific `info` string so the bytes that
encrypt these values are never the bytes that sign sessions.

The API never returns a value. `GET /api/me/site` reports `envKeys` only,
which is why `PUT /api/me/site/git` accepts an entry with **no `value`**,
meaning "keep the one you already have" — that's what lets the settings
form delete one variable without making you re-type the other four.
Sending `env` at all replaces the whole set; omitting it leaves the
variables untouched.

Rotating (or losing) the secret makes stored values undecryptable. That
fails the deployment with a "re-enter them in Settings" message rather
than building without the variable, because a build that quietly runs
without the key it needs produces a broken site that looks like a
successful deploy.

## Nginx

```nginx
# App and API (both terminated here in production)
server {
  server_name app.example.com;
  location / { proxy_pass http://127.0.0.1:5173; }  # or served static
}
server {
  server_name api.example.com;
  location / { proxy_pass http://127.0.0.1:3000; }
}

# Every hosted portfolio (wildcard) — nginx just resolves
# PORTFOLIOS_DIR/<slug> which is a symlink this API owns.
server {
  server_name ~^(?<slug>[a-z0-9][a-z0-9-]*)\.example\.com$;
  root /var/portfolios;
  location / { try_files /$slug$uri /$slug$uri/ /$slug/index.html =404; }
}
```

## Known gaps

### The `@pb/templates` pin is unresolved on purpose

`bun.lock` carries no entry for `@pb/templates`. The résumé/photo work
needs the templates commit that adds `src/uploads.ts`, and this
environment cannot reach GitHub's tarball API
(`api.github.com/repos/.../tarball/...` → 403 from the egress proxy;
`codeload.github.com` is fine but produces different bytes, so a valid
integrity hash can't be derived from it either).

Leaving the old entry in place would have been worse than removing it: a
plain `bun install` keeps a locked commit for a `#branch` specifier, so
it would have quietly reinstalled a `@pb/templates` without `uploads.ts`
and broken the build with a confusing missing-export error. With no
entry, `bun install` re-resolves `#master` and writes a correct one, and
`--frozen-lockfile` fails loudly instead of installing the wrong thing.

**Run `bun install` once from an environment with GitHub API access and
commit the regenerated `bun.lock`.** Everything else here was verified
against the real package contents, vendored into `node_modules` from a
checkout of the merged templates commit.

### `better-auth` no longer sends `Account.issuer`

Found while exercising a real server boot: with the version `^1.7.1`
currently resolves to (1.7.3), `POST /api/auth/sign-up/email` fails with
Prisma's `Argument \`issuer\` is missing`. better-auth stopped emitting the
field that `schema.prisma` still marks required — see the comment on
`Account.issuer`, which documents the opposite behaviour in the version
that was installed when it was written.

Full server boot (Better Auth + Prisma against a live Postgres) has not
been exercised in this environment — there's no local Postgres available
here. Everything up to that boundary is verified: the module graph
type-checks cleanly end to end, and the build → publish → rename →
unpublish pipeline was run for real against the templates repo's Aurora
template. Point `DATABASE_URL`/`DIRECT_URL` at a real (or local)
Postgres and run `prisma migrate dev` before the first `bun run dev`.

### Portfolio sections and runtime appearance

The shared schema now supports education, achievements, custom sections, and up to ten labeled links per project. Profile JSON storage requires no database migration. All added rich-text fields are sanitized before persistence; export and hosting copy the shared section and runtime-theme components alongside the chosen template.

When deploying this release, update the checkout configured by `TEMPLATES_DIR` to the same templates revision pinned in `package.json`, install dependencies, and restart the API before updating the UI. Existing exported/published portfolios acquire these features when exported/published again.
