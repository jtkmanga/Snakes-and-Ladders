# Slip2Go Admin — Snakes & Ladders staging

## Admin page

Open: `https://snakes-and-ladders-staging.jtkmanga.workers.dev/admin.html`

Login with the Firebase Google identity configured in the Worker `ADMIN_EMAIL` variable. The API checks the verified Firebase ID token for every request; a matching browser email alone is not sufficient.

The menu in the game also includes **ระบบหลังบ้าน Admin**.

## Read-only operations

- Account/quota dashboard: `GET /api/admin/slip2go/account` → Slip2Go `GET https://connect.slip2go.com/api/account/info`
- Look up previously checked slip: `GET /api/admin/slip2go/history?referenceId=<slip2go-reference>` → Slip2Go `GET https://connect.slip2go.com/api/verify-slip/{referenceId}`
- Test access after Google sign-in: `GET /api/admin/session`

All three routes require the same Google Admin allowlist. The provider token stays in the Worker secret and is sent only to the pinned HTTPS provider hostname. Reference IDs are validated for length and characters, and history omits raw QR code and bank-account holder names and masks the recipient account number. The dashboard does **not** edit scores, grant VIP, verify new slips, or trigger payments.

The `referenceId` is a Slip2Go slip-verification reference returned from a previous check, not the in-game `order-...` ID.

## Staging safety

- Keep `PAYMENTS_ENABLED=false` until an approved end-to-end canary completes.
- `SLIP2GO_SECRET` and `MERCHANT_ACCOUNT_NUMBER` must remain Cloudflare secret bindings.
- `ADMIN_EMAIL` is the only Admin allowlist (no matching email = HTTP 403).
- Do not publish tokens, full PromptPay number, or screenshots containing bank credentials.
- Admin account-info calls are read-only; slip-history calls fetch existing records, not new slip verification.
- Avoid refreshing the dashboard too frequently; Slip2Go API requests may be subject to rate limits.
- Run `npm run check` before changing the Worker.
- This repository's `wrangler.jsonc` expects Assets and does not include all Staging bindings. A blind deploy could change the working configuration. Use a deliberately reconciled deploy process.

## Verification

GitHub Actions 70/70 tests passed on the implementation commit. Cloudflare API confirmed the active version at 100% traffic and all existing Firebase/DO/secrets preserved. A live mobile sign-in and provider account response still need user confirmation. The public URL could not be externally retrieved by the assistant's web client (the platform returned an access error); do not treat this as a verified live browser smoke test.

## Official docs

- https://slip2go.com/guide/rest-api/account-info
- https://slip2go.com/guide/rest-api/slip-history
- https://slip2go.com/guide/authentication
