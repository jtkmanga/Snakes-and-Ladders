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
Store in Cloudflare Worker **Secrets** (never regular plaintext variables):
- `SLIP2GO_SECRET` — API credential.
- `MERCHANT_ACCOUNT_NUMBER` — Thai PromptPay mobile number (10 digits). No full phone is presented as text in the game.

Set Worker **Vars**:
- `SLIP2GO_API_BASE_URL=https://connect.slip2go.com/` — confirmed by the merchant's supplied REST endpoint `https://connect.slip2go.com/api/verify-slip/qr-image/info`. The Worker now allows ONLY this HTTPS origin.
- `MERCHANT_ACCOUNT_TYPE=02001` — Slip2Go's code for PromptPay by mobile number.
- `MERCHANT_DISPLAY_NAME=Lucky Game` — recipient label shown in the game.
- Optional `MERCHANT_ACCOUNT_NAME_TH` — recipient Thai legal name verification.
- `PAYMENTS_ENABLED` — **keep `false`** until an approved, controlled canary completes.

The order QR is constructed on the Worker with an exact server-side amount (VIP ฿100, win×2 ฿20, snake shield ฿10). Only the authenticated owner of an unexpired pending order may fetch the no-store SVG; the mobile page converts it to a PNG for saving. The original phone number is not included in plaintext HTML/API JSON.

**Privacy limit:** A standard PromptPay QR contains an encoded recipient identifier; anyone who can access or scan the QR may recover the mobile number. Merely hiding the number on screen is not anonymity. Use a merchant-issued QR identifier/payment gateway rather than a phone-linked QR if full phone secrecy is required.

The payment page and QR route are gated by `PAYMENTS_ENABLED=false` until real merchant configuration and a controlled canary are verified. No money has been accepted or transfers initiated for this project.

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

## Payment completion pass — adapting lessons from GPT-VOXEL-3D (8 Nov 2026)
- Reused the previously tested Slip2Go server communication contract: `Authorization: <raw Slip2Go Secret Key>` and multipart `file` plus `payload`. Cloudflare `SLIP2GO_SECRET` remains protected; no key is placed in the frontend or repository.
- Keep **strict provider code `200200`** for a verified sale. Code `200000` only confirms a slip was found; it must NOT grant entitlement without passed receiver/amount checks. Server also checks exact amount, recent time, and transaction reference.
- Check duplicate transactions in two layers: Slip2Go `checkDuplicate:true` and the Durable Object's atomic `transfers` table. This is important because the same merchant/shop may be used by the older game; local game-only deduplication would not catch cross-game reuse.
- Fingerprint the bank/sender reference (not a screenshot or decoded QR) so changing the PNG cannot create a second purchase.
- Added authenticated `GET /api/orders/recent` and the "ตรวจคำสั่งซื้อเดิม / กู้คืนสิทธิ์" button. A user may recover their own recent pending/verified/fulfilled order after reload; a verified unfulfilled order can be reconciled without another transfer.
- The mobile payment UI already prepares QR for VIP ฿100, win multiplier ฿20 and shield ฿10, plus PNG save and slip upload.
- The entire public payment system remains **OFF** with `PAYMENTS_ENABLED=false`. Neither real receiving QR nor live Slip2Go check has been tested in this work pass. Live merchant API acceptance and a controlled authorized canary remain outstanding.
- Admin UI work is paused at the merchant's request; do not depend on admin history screens for the payment flow.

## Merchant API preflight (8 November 2026)
- Official Slip2Go Authentication documentation specifies the *raw* Secret Key as the Authorization header value. Previous Voxel code used a Bearer prefix, so the new game's adapter now follows the published contract, not an unverified assumption. Source: https://slip2go.com/guide/authentication
- The authenticated owner has a read-only test button on the **game's sign-in screen**, not the deferred admin dashboard. GET `/api/payment/preflight` calls the Slip2Go account-info endpoint with a 12-second timeout and returns a bounded status, shop label, and safe quota values. It **does not** create an order, generate a QR, submit a slip, or change `PAYMENTS_ENABLED`.
- The button is offered only if `/api/me` confirms `canPaymentPreflight`, using the verified Google UID and server-side `ADMIN_EMAIL` check. Non-owners receive HTTP 403 even if they invoke the URL directly.
- On mobile, if no order is found in the last seven days, the recovery panel now ends its progress message and offers a one-tap **view-only** checkout preview. This demo does not expose a scan-able PromptPay QR.
- CI: 86/86 tests passed. Cloudflare staging script deployed, traffic 100%; `PAYMENTS_ENABLED=false`, `PAYMENT_ROLLOUT=canary`, merchant secrets remain encrypted, all six Durable Object bindings remain intact.
- **Still pending live validation**: owner clicks the read-only API test and reports the result; only after it passes should a separate, explicitly authorized owner-only payment canary be considered. Do not enable general-public checkout or infer a successful real Slip2Go call from unit tests.

## Live-money owner canary — 8 November 2026

**This is NOT a public payment launch and does NOT establish 100% end-to-end success.**

- Current Cloudflare Staging bindings: `PAYMENTS_ENABLED=true`, `PAYMENT_ROLLOUT=canary`. Only the verified Google identity matching `ADMIN_EMAIL` may create live orders.
- Initially only the `shield` item (THB10) is eligible. VIP THB100 and win multiplier THB20 remain disabled during this pilot. A verified/fulfilled pilot order prevents a second live order without an explicit later release.
- Preflight before creating an order: GET `/api/account/info` with raw `Authorization` Secret; require the exact configured shop name `Lucky Game`, a current package expiration, and sufficient verification quota. **If the upstream call fails, no live order or QR is created.**
- Corrected the cause of previous preflight error: Cloudflare Workers does not support `fetch` with `redirect:'error'`; it throws a TypeError before the request reaches Slip2Go. Both the admin read-only helper and verification request now use `redirect:'manual'` and do not follow redirects. Reference: https://developers.cloudflare.com/workers/runtime-apis/request/
- Bank QR is rendered **from the server-stored PromptPay Secret for each order's exact THB amount**. The user-provided static QR screenshot is not used as a live order QR.
- Transfer must occur during the original 15-minute QR window. An authentic slip for that timed transfer may be uploaded for 24h for recovery; bank transfer IDs are hashed and checked against the Durable Object ledger. `200200` provider validation is required, along with checkDuplicate, exact receiver, amount and date constraints.
- Approval to turn on the **owner-only** payment canary does not authorize a public rollout.
- GitHub Actions 91/91 checks passed. Cloudflare reported version `a48e6542-d78b-4752-8d92-a29a72f7e23d` deployed at 100% traffic; Firebase bindings and all 6 Durable Objects preserved; payment Secret and receiving phone remain secret bindings.
- **Next manual smoke test:** owner signs in to Staging and clicks “ทดสอบเชื่อม Slip2Go” first. Only if success, enter Lobby → Shop → “เกราะกันงู ซื้อจริง ฿10”. Confirm bank app displays correct receiving account/name and THB10 before transferring. Attach the genuine slip to that exact order. Confirm entitlement and no double grants. If any check fails, do not transfer and report the sanitized error.
