# Order backend

These endpoints are server infrastructure only. They are not wired into the missing browser modules.

## Netlify environment

Configure these variables in the Netlify function environment:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the existing server side Supabase client.
- `PAGPIXHUB_API_KEY` for PagPix Hub requests. Create this key in PagPix Hub and store it only in the Netlify function environment.
- `PAGPIXHUB_WEBHOOK_SECRET` for validating the PagPix Hub webhook signature. Configure the webhook in PagPix Hub to call `/api/pagpix-webhook` and copy its `whsec_...` secret into this variable.
- `CHECKOUT_TOKEN_SECRETS_JSON`: version-to-secret JSON map, for example `{"1":"<old-32-byte-secret>","2":"<new-32-byte-secret>"}`. Each secret must contain at least 32 bytes. Keep old versions available while any order can still be accessed. Version 1 preserves tokens issued by the original backend.
- `CHECKOUT_TOKEN_ACTIVE_VERSION`: map key used for new orders. Add a new secret/version and switch this value to rotate; do not remove earlier keys while their orders remain accessible. If the map is absent, the legacy `CHECKOUT_TOKEN_SECRET` is accepted as version 1.
- `PIX_MAX_AMOUNT_CENTS`: required integer between 500 (PagPix Hub minimum) and PostgreSQL `integer` maximum (`2147483647`).
- `PIX_ORDER_CATALOG_JSON`: server-owned JSON map of SKU to trusted price and name. Example shape: `{"SKU_1":{"name":"Item","unitAmountCents":2590,"requiresShipping":true}}`. Never accept prices or descriptions from the browser as authoritative.
- `ORDER_OPERATIONS_TOKEN`: at least 32 random bytes encoded as hex or base64url, used only by an authorized server/operator to update shipment data.
- `RATE_LIMIT_SECRET`: at least 32 random bytes. It HMAC-hashes the trusted Netlify client IP before storing rate-limit buckets in Supabase.

Apply the three order/backend migrations, including `20261107193000_tracking_code_unique.sql`, before enabling the endpoints. The last migration stops if it finds duplicate non-null tracking codes, so resolve those duplicates after review before applying it. The rate limiter fails closed until its table and RPC are available. Keep all secrets server-side only.

## Endpoints

### `POST /api/create-order`

Requires an `Idempotency-Key` header (16–200 characters). The JSON body contains `items` (`sku`, `quantity`), `customer` (`name`, `email`, `document`, `phone`) and, when any catalog item requires shipping, `shippingAddress` (`street`, `number`, `district`, `city`, `state`, `cep`, optional `complement`). Prices are calculated from `PIX_ORDER_CATALOG_JSON`.

Returns `orderId`, `reference`, `amountCents`, `status`, and `checkoutToken`. Pass `orderId` and `checkoutToken` to the existing `/api/create-pix` endpoint. The payment row is then associated with the order through the existing unique `order_id` and `reference` constraints.

The same idempotency key and same normalized request return the same order and token. Reusing the key for a different request returns HTTP 409.

Request bodies are limited to 16 KiB. The route rate limits by the Netlify `context.ip` (with the Netlify client-IP header as a runtime compatibility fallback).

### `GET /api/orders?orderId={uuid}`

Requires `Authorization: Bearer {checkoutToken}`. An invalid ID or token returns the same 404 response. The response contains the order, payment state and registered delivery/tracking data. Responses are not cacheable.

### `POST /api/update-order-tracking`

Requires `Authorization: Bearer {ORDER_OPERATIONS_TOKEN}` and accepts `orderId`, `deliveryStatus`, and optional `carrier`, `trackingCode`, `trackingUrl`. Tracking URLs must use HTTPS. This endpoint only updates orders whose payment status is `paid`; clients must never call it directly.

Updates are atomic, transition-checked, and recorded in `pix_order_tracking_events`. The order lookup returns the latest 100 events in chronological order. Repeating a status does not reset its first shipped/delivered timestamp.

### `POST /api/track-order`

Accepts `{ "code": "..." }` for public tracking lookup. Only a unique tracking code attached to a paid order is returned. The response contains logistics status and tracking history, without customer, address, or order details. This route is rate-limited and does not authenticate the visitor; the tracking code therefore acts as a bearer lookup value and should be treated as sensitive. No carrier API is connected; updates remain operator-entered through the protected tracking endpoint.

## PIX recovery and webhook validation

PagPix Hub creates PIX charges with an idempotency key derived from the order reference. The API checks the returned amount, stores the transaction id and copy-and-paste code, and returns a pending `pix_status` if the code is still generating. A retry reconciles by `external_reference`; it does not create a second charge for an existing `creating`/`pending` record. The PagPix webhook is accepted only with a valid HMAC-SHA256 signature and matching transaction id, reference, and amount.

The PagPix webhook validates its documented `PagPixHub-Signature` HMAC header (including the five-minute replay window), rate limits requests, and matches the signed transaction event to the stored reference, amount, and gateway transaction ID before changing payment state.

## Unavailable configuration

The repository does not contain the product catalog or deployment secrets. Until the environment variables above are configured and the migrations are applied, order creation fails closed. The frontend modules are also absent, so no browser flow is connected by this change.

Rate limit defaults in the function handlers: create-order 10/minute and 80/hour per IP; create-pix 10/minute and 60/hour per IP plus 4 attempts per order per 10 minutes; order lookup 60/minute and 600/hour per IP plus 30/minute per order; webhook 120/minute and 600/hour per IP; tracking updates 30/minute per IP. Review these operational limits against expected homologation and production volume.

