# Context — emdash-cms/emdash

- **Config-pin tests**: asserting a config literal, constant, or schema shape back at itself. It re-states the source file and fails only when someone makes an intentional change.
- **Core structure:** `packages/core/tests/unit/`, `packages/core/tests/integration/`, and `packages/core/tests/workerd/`. Test files mirror source structure. Each database test gets a fresh DB.
- **Framework:** Vitest for package tests and Playwright for browser tests. Package tests usually live in that package's `tests/` or `test/` directory; core tests live in `packages/core/tests/`, and browser tests live in `e2e/tests/`.
- **Mocking the unit under test**, or a mock that returns the very value the assertion checks. The test then verifies the mock, not the code.
- **No mocks for the DB.** Node's built-in SQLite driver by default. PostgreSQL parity tests via a real `pg` connection with per-test schema isolation (set `EMDASH_TEST_PG` to a connection string for a role with `CREATEDB` to opt in).
- **Tautological tests**: asserting the implementation detail you just wrote straight back -- add a CSS class to a component, then test the component has that class; call a function with arguments, then assert it was called with those arguments. This re-states the diff, not the behavior. Test what the change does for the user (the element is hidden, the query is filtered), not that the code you wrote is the code you wrote.
- **Tests that only exercise third-party code**: Kysely, Zod, and Lingui have their own test suites. Test your behavior, not theirs.
- **Utilities:** `tests/utils/test-db.ts` exposes `setupTestDatabase()`, `setupTestDatabaseWithCollections()`, `teardownTestDatabase()` for SQLite and `setupTestPostgresDatabase()` etc. for Postgres. Dialect-agnostic: `setupForDialect`, `setupForDialectWithCollections`, `teardownForDialect`, plus `describeEachDialect(name, fn)`. Use the dialect wrapper for query-builder code -- regressions tend to be dialect-specific.
- **oxfmt** -- formatting (tabs, configured in `.prettierrc`). All source files use tabs.
- **pnpm** -- package manager
- **tsdown** -- TypeScript builds (ESM + DTS)
- **vitest** -- testing
- `GET /_emdash/api/auth/dev-bypass?redirect=/_emdash/admin` -- assumes setup is complete, just creates a session.
- `GET /_emdash/api/setup/dev-bypass?redirect=/_emdash/admin` -- runs migrations, creates a dev admin user (`dev@emdash.local`), establishes a session, redirects.
## admin-ui:-localization-(lingui)
- **Don't include `messages.po` changes in non-translation PRs.** A workflow runs `pnpm locale:extract` on merge to `main`. Including extracted catalog updates in feature PRs creates merge churn -- revert before opening.
- Bare string literals in JSX, unwrapped aria/title/placeholder/alt attributes.
- Calling `t` at module scope -- locale isn't bound. Use `msg` + `t(descriptor)` inside a component.
- Catalogs: `packages/admin/src/locales/{locale}/messages.po`. English is source.
- Concatenating translated pieces (`` t`Hello ` + name``) -- breaks word order. Use `` t`Hello ${name}` `` or `<Trans>`.
- Enabled locales: `packages/admin/src/locales/locales.ts`.
- Set `EMDASH_PSEUDO_LOCALE=1` in dev to render pseudo-localized text and spot untranslated leaks. const { t } = useLingui(); return <button aria-label={t`Delete post`}>{t`Delete`}</button>; { id: "paragraph", label: msg`Paragraph` },

## api-routes
- **Never** add GET handlers for state-changing operations.
- Access runtime via `const { emdash } = locals;`, user via `locals.user`.
- Every route file starts with `export const prerender = false;`.
- File structure mirrors URLs: `content/[collection]/index.ts` for list/create, `[id].ts` for get/update/delete, sub-actions as siblings.
- Named exports: `export const GET: APIRoute`, etc. Destructure from the Astro context.

## architecture
- **Handler layer** (`packages/core/src/api/handlers/*.ts`) holds business logic and returns `ApiResult<T>` (`{ success: true, data } | { success: false, error: { code, message, details? } }`). Route files are thin wrappers.
- **Middleware chain:** runtime init -> setup check -> auth -> request context (ALS). Auth middleware checks authentication only; routes check authorization.
- **Schema in the database.** `_emdash_collections` and `_emdash_fields` are the source of truth. Each collection gets a real SQL table (`ec_posts`, `ec_products`) with typed columns -- not EAV.
- **Storage abstraction:** `Storage` interface with `upload/download/delete/exists/list/getSignedUploadUrl/getPublicUrl`. `LocalStorage` for a local directory, `S3Storage` for S3-compatible services (including R2's S3 API), `R2Storage` (in `@emdash-cms/cloudflare`) for R2 bindings. Access via `emdash.storage` from locals.

## comments
- PR descriptions or summaries of the change
- justification for a decision ("intentionally", "for safety", "we accept", "unlike X")
- messages to the reviewer
- narrative about what you tried and rejected
- restatements of what the code plainly does
- the code is unclear and genuinely can't be made clearer (first try making it clearer), or
- there's a non-obvious reason for something the reader would otherwise get wrong (an ordering constraint, a footgun, an invariant).

## content-localization
- Any new query against a content table must filter by `locale` -- forgetting this is a correctness bug.
- Every `ec_*` table has `locale` (defaults to `'en'`) and `translation_group` (ULID shared across translations).
- Fetch all translations via `GET /_emdash/api/content/{collection}/{id}/translations`. return requestCached(`siteSetting:${key}`, async () => { const db = await getDb(); return ...; }); try { await recoverStaleLocks(); } catch (error) { console.error("[cron] recovery failed:", error); }
- Slug uniqueness is `UNIQUE(slug, locale)`, not global.

## content-tables
- **Field type -> column mapping:** `FIELD_TYPE_TO_COLUMN` in `schema/types.ts`. Most string-shaped types -> TEXT; number -> REAL; integer/boolean -> INTEGER; portableText/json/multiSelect -> JSON.
- **Names:** `ec_{collection_slug}`. System tables: `_emdash_{name}`.
- **Orphan discovery:** `discoverOrphanedTables()` finds `ec_*` tables without a matching `_emdash_collections` row.
- **Slugs:** `/^[a-z][a-z0-9_]*$/`, max 63 chars, checked against `RESERVED_COLLECTION_SLUGS` / `RESERVED_FIELD_SLUGS`.
- **Standard columns:** `id`, `slug`, `status`, `author_id`, `created_at`, `updated_at`, `published_at`, `scheduled_at`, `deleted_at`, `version`, `live_revision_id`, `draft_revision_id`. Field columns added via `ALTER TABLE`.

## database:-never-interpolate-into-sql
- **Never** use `sql.raw()` with string interpolation or template literals containing variables.
- For **identifiers** (table/column names), use `sql.ref()`.
- For **values**, use Kysely's `sql` tagged template -- interpolated values are automatically parameterized.
- If you must use `sql.raw()` for dynamic identifiers, validate with `validateIdentifier()` from `database/validate.ts` first (asserts `/^[a-z][a-z0-9_]*$/`).
- The `json_extract(data, '$.${field}')` pattern is particularly dangerous -- always validate `field`.

## environment
- **Secrets read `process.env` only, never `import.meta.env`** -- Vite statically inlines `import.meta.env`, which bakes build-machine secrets into the bundle and shadows runtime values set on the deployment platform. See `packages/core/src/config/secrets.ts`.
- Dev-only endpoints must check `import.meta.env.DEV` and return 403 otherwise -- it's a compile-time constant, unspoofable at runtime.
- Public build-time config pattern: `import.meta.env.EMDASH_X || import.meta.env.X || ""`.
- Use `import.meta.env.DEV` / `import.meta.env.PROD` (Vite/Astro standard). Never `process.env.NODE_ENV`.

## handler-layer
- Error codes are `SCREAMING_SNAKE_CASE` (`NOT_FOUND`, `VALIDATION_ERROR`, `CONTENT_CREATE_ERROR`).
- First parameter is always `db: Kysely<Database>`, followed by route-specific params.
- Return `ApiResult<T>`.
- Wrap the body in try/catch. Errors return `{ success: false, error: { code, message } }`.

## imports
- **Barrel files** separate `export type { ... }` from value exports.
- **Internal imports** use `.js` extensions (ESM): `import { X } from "../foo.js"`.
- **Package imports** have no extension: `import { sql } from "kysely"`.
- **Type-only imports** use `import type` (`verbatimModuleSyntax` is on).
- **Virtual modules** need a `// @ts-ignore`: `// @ts-ignore - virtual module` above `import virtualConfig from "virtual:emdash/config"`.

## kumo-components
- Admin API client functions use `throwResponseError()` from `lib/api/client.ts` to surface server messages -- never `throw new Error("Failed to X")` and lose the body.
- Never duplicate component styles. If you're writing `bg-kumo-brand text-white rounded-md px-3 py-2` on a `<button>`, use Kumo's `Button` instead.
- Never use `dark:` prefixes. Kumo's tokens use CSS `light-dark()`.
- Use semantic tokens (`bg-kumo-brand`, `text-kumo-subtle`). Never raw Tailwind colors.
- `ConfirmDialog` (in `components/`) for confirm/cancel modals. Pass `mutation.error` directly -- don't manage error state manually.
- `DialogError` + `getMutationError()` for inline errors in form dialogs.

## migrations
- **Column types:** SQLite -- `text`, `integer`, `real`, `blob`. Booleans are `integer` defaulting to 0. Timestamps are `text` with ``defaultTo(sql`(datetime('now'))`)``. IDs are `text` primary keys (ULIDs from `ulidx`).
- **Dynamic content tables (`ec_*`):** `sql` tagged templates with `sql.ref()` for identifiers.
- **Exports:** `up(db: Kysely<unknown>)` and `down(db: Kysely<unknown>)`.
- **Multi-table migrations:** When altering all content tables, query `_emdash_collections` and loop. See `013_scheduled_publishing.ts`.
- **Naming:** `NNN_descriptive_name.ts`, zero-padded.
- **Registration:** Migrations are statically imported in `runner.ts` and added to `StaticMigrationProvider`. Not auto-discovered (Workers bundler compatibility). When adding: create the file, add a static import in `runner.ts`, add it to `getMigrations()`.
- **System tables:** Kysely schema builder.

## workflow
- Run `pnpm build` from the repository root. Package-scoped builds are not sufficient because validation resolves declaration output from other workspace packages.
- Run `pnpm format`.
- Run `pnpm lint:quick` and confirm `pnpm --silent lint:json | jq '.diagnostics | length'` returns zero.
- Run `pnpm typecheck` (packages) or `pnpm typecheck:demos` (Astro demos). --attach './interface-error.png#The settings screen showing the validation error' --attach './before.png#Settings screen before the change' \ --attach './after.png#Settings screen after the change'
- Run the tests relevant to the changed behavior.
