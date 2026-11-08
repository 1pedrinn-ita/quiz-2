# Frontend integration staging

This folder is isolated from the production publish directory. The recovered
original files remain byte-for-byte under `../ocorrecorrendotudo`; changes to
the integration copy do not overwrite those originals. Do not deploy this
configuration as production.

## Payment safety

`netlify/functions/create-pix.mjs` is a staging-only simulator and has no
PinguPag import or network call. It returns a visibly non-payable
`SIMULATION-ONLY-NOT-A-PIX-...` string. Payment approval is a separate operator
test route guarded by `STAGING_SIMULATOR_ENABLED=true` and a 32+ character
`STAGING_SIMULATOR_SECRET`; the browser bridge never calls that route. Keep the
flag disabled except in an isolated staging environment with fictitious data.
The production `create-pix.mjs` remains in the project root and is not copied
into the production publish directory by this staging config.

## Required staging configuration

Configure only in a separate Netlify staging site and separate Supabase project:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `CHECKOUT_TOKEN_SECRET` (32+ random bytes) or versioned
  `CHECKOUT_TOKEN_SECRETS_JSON` plus `CHECKOUT_TOKEN_ACTIVE_VERSION`
- `RATE_LIMIT_SECRET` (32+ random bytes)
- `ORDER_ACCESS_CODE_SECRET` (32+ random bytes; derives stable per-order access codes)
- `ORDER_OPERATIONS_TOKEN` (32+ random bytes; required only by the protected tracking-update route)
- `PIX_MAX_AMOUNT_CENTS`
- `PIX_ORDER_CATALOG_JSON` with these exact SKU keys and server-owned amounts:
  `corre-rosa-kit` (9790 cents), `socks` (1990), `visor` (2990),
  `colored-socks` (1990), `express-shipping` (845). Mark the kit and add-ons
  `requiresShipping: true`. The shipping SKU does not require shipping.
- `STAGING_SIMULATOR_ENABLED=true` only for the isolated staging project. Set
  `STAGING_SIMULATOR_SECRET` only when running operator tests.

These catalog values are a compatibility gate derived from the original UI;
the backend remains authoritative. If the actual approved catalog differs,
stop and reconcile it before using checkout. No real provider credentials are
needed or used by this staging flow.

`supabase/config.toml` targets a local Supabase stack (`127.0.0.1`) and uses
the isolated project id `quiz-2-staging`. `.env.staging.example` contains only
placeholders and a local Supabase URL. Do not replace that URL with production
settings. Any later authorized Netlify staging site must use a separate
Supabase project URL and its own service role key.

## Database

Apply the copied migrations only to the dedicated staging Supabase project.
The staging-only migration adds a unique hash column for the original `CR-...`
post-sale code. The code is deterministically derived server-side for the
authenticated order owner; only its digest is stored. The lookup route returns
no customer PII, and only responds for orders
with both an approved payment and matching amount/reference. No migration has
been applied by this work.

The recovered source assets remain unchanged. A separate staging-only
selection page is available at `/selecionar/`; it uses the original product
images and size catalog, then hands off to the existing checkout. Its details
and the current freight-catalog discrepancy are documented in
`CHECKOUT-UNIFICADO.md`. Original assets that remain unavailable are listed in
`ASSETS.md`.

On the post-sale tracking page, the staging adapter replaces the original
placeholder timeline with only stored delivery-history rows. It removes the
timeline when no verified status has been recorded and includes timestamps,
carrier names, codes, and links only when the backend has them. The backend
does not fetch carrier events itself; operators must enter confirmed carrier
updates through the protected tracking route.
