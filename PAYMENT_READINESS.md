# Snakes & Ladders — VIP / Slip2Go release checklist (7 Nov 2026)

## Staging state
- Google login and free multiplayer have passed real-mobile testing.
- VIP membership capacity: 100 **active subscriptions** plus temporary unexpired holds count against available slots. Each purchased VIP period is 30 days; renewal extends from current expiry.
- Paid products: VIP ฿100 / 30 days; win reward x2 ฿20 / 24 hours; snake shield ฿10 / 24 hours.
- All prices are authoritative in `src/payments.js`, not in the browser.
- **PAYMENTS_ENABLED=false**. No live payment verification was performed. Never set true until receiver ownership, configuration, and canary payment are verified.

## Changes in this release
- A previously verified VIP order can safely re-reserve its seat after the 15-minute checkout hold expires, **only if capacity is still available**. Never exceed 100.
- If capacity is full after the customer has already paid and the original hold expired, the order remains `verified`, not `fulfilled`. Support must reconcile / refund as appropriate; do not ask the user to transfer again.
- A rejected VIP checkout cancels its unverified pending order.
- A non-successful final ledger write does not return success. Retrying reconciliation must not extend an already applied VIP subscription a second time.
- The payment UI offers **Check entitlement status** using the existing order. No second slip is sent to Slip2Go by this button.
- The server checks Google Firebase ID tokens, owns catalog prices, validates provider response code `200200`, amount, receiver condition and transfer timing, and fingerprints bank transfers for duplicate prevention.

## Exact Cloudflare configuration (never commit secrets)
Store in Cloudflare Worker **Secrets**: `SLIP2GO_SECRET`.
Set Worker **Vars** securely after confirming the merchant account:
- `SLIP2GO_API_BASE_URL` — verified API origin, e.g. `https://api.slip2go.com/` after confirming the merchant's dashboard docs.
- `MERCHANT_ACCOUNT_TYPE` — Slip2Go's account type code for your real receiving account.
- `MERCHANT_ACCOUNT_NUMBER` — real number as required by Slip2Go's `checkReceiver.accountNumber`.
- Optional `MERCHANT_ACCOUNT_NAME_TH` — for additional recipient-name verification.
- `MERCHANT_DISPLAY_NAME` — recipient display name.
- `MERCHANT_PUBLIC_ACCOUNT` — recipient details that customers should see when paying.
- `PAYMENTS_ENABLED` — **keep `false`** until an approved controlled canary completes.

Never paste Slip2Go secret, bank private credentials, or Firebase service-account private key in chat or a repository.

## Payment safety gates before enabling public payment
1. Verify recipient bank/PromptPay details in Slip2Go are accurate and belong to the intended merchant; validate `checkReceiver` and merchant dashboard history.
2. Run automated unit tests and Cloudflare Staging smoke tests with payments disabled.
3. Enable narrowly scoped canary only with explicit merchant approval after configuring secrets. Pay with one **new authorized transaction**; confirm slip verifies, correct order/UID receives entitlement, dashboard history matches and a duplicate transfer does not create a second entitlement.
4. Verify VIP capacity at 99, 100, expired members, pending reservation expiry and reactivation; ensure paid-but-unfulfilled orders are tracked for manual review/refund.
5. Test shop item expiry 24h and winner x2 (not Lucky Box), snake shield once per game.
6. Confirm real transaction reconciliation, failure alerting and refund/support policy. Monitor API quotas.
7. Only then consider payment rollout. Cloudflare Free capacity for 10,000 concurrent players is unproven and cannot be guaranteed free.

## Important deployment warning
Staging is deployed via Cloudflare API with embedded static router. Repository `wrangler.jsonc` expects `env.ASSETS` and does not configure Firebase Vars. A blind `wrangler deploy` can replace staging bindings/settings. Do not deploy from an unvalidated config.

## References
- https://slip2go.com/guide/rest-api/image
- https://slip2go.com/guide/response
- https://slip2go.com/guide/authentication
