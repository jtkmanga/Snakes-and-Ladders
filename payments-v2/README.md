## 8 November 2026 — V74 owner-only real payment popup for 3 products

Owner request: tapping VIP or item Buy must immediately open a modal with a real server order and QR, not a simulated payment. This request is now implemented in Cloudflare Staging Worker V74. The payment dialog opens instantly; QR appears only after the authenticated order creation and real provider merchant-readiness checks succeed.

Pricing: VIP membership 30 days 100 THB, win2 reward multiplier 20 THB for 24 hours, shield 10 THB for 24 hours. The old first-order-only/shield-only canary restriction was removed for the verified owner account. Google-authenticated owner-only checkout still applies to every live payment endpoint. Environment still has PAYMENTS_ENABLED=true, PAYMENT_ROLLOUT=canary, PAYMENT_V2_OWNER_CANARY=explicitly_approved. No public rollout.

V74 payment UI: fixed mobile scrollable modal, explicit QR loading status and don't-transfer-until-QR message, correct amount and merchant, QR PNG save, raw PNG/JPEG bank slip upload and recovered order status. After successful or verified-but-pending delivery the slip submit button remains disabled, reducing accidental duplicate submission. Real QR is built on the Worker based on the server-stored order and E-Wallet receiver. All payment simulation buttons remain removed from the game and admin.

Security: source of truth is a dedicated shared SQLite Durable Object; per-SKU pending order reuse, request rate limiting, transfer fingerprint replay rejection, amount and receiver validation, successful Slip2Go provider code 200200 and exactly-once VIP or inventory delivery. New production paths use merchant preflight before order creation and QR display. VIP capacity is reserved before issuing payable QR. Offline fake-provider integration tests pass.

Evidence: deployed V74; payment code and V74 snapshot in payment-v2-rebuild branch; GitHub Actions green; source snapshots staging-game-v74.mjs, staging-index-v74.html, staging-main-v73.mjs, staging-style-v73.css, staging-admin-v73.html. This remains a Staging-only change; PR #2 is a Draft and not merged into main.

**Real bank-transfer settlement has not been tested.** The owner must inspect payee in their mobile banking app, verify the first transfer arrived and Slip2Go detects the actual slip, then confirm the intended VIP/item grant. Do not claim 100% verified real settlement or switch to public rollout until these checks pass.

Game: https://snakes-and-ladders-staging.jtkmanga.workers.dev/?v=74
Admin: https://snakes-and-ladders-staging.jtkmanga.workers.dev/admin

---

## 8 November 2026 — Live-money owner-only canary, Worker V72

The owner explicitly asked for a REAL payment flow and for ALL payment simulation buttons to be removed. This supersedes the old Stage 5 hold instruction FOR OWNER ONLY. Public payment rollout remains prohibited pending first transfer confirmation.

Cloudflare staging V72: 100% deployed, 19 bindings with the existing secret provider key and E-Wallet receiver; PAYMENTS_ENABLED=true, PAYMENT_ROLLOUT=canary, PAYMENT_V2_OWNER_CANARY=explicitly_approved, and code V2_STAGE5_LOCKED=false. Verified Firebase Google owner identity is mandatory. Non-admin buyers get 403; no public checkout is enabled.

Real-money first transaction is limited to ONE shield order at 10 THB globally in the dedicated payment-v2-paid-ledger-v1 Durable Object. VIP 100 THB and win2 20 THB remain disabled until first bank transfer is verified. Before order creation and before returning a payable QR, the Cloudflare Worker performs read-only Slip2Go merchant checks including shop name, package expiry and available quota. Failed checks return 503 and no payable QR.

The actual V2 path includes server-authoritative pricing, one UID per order, unique transfer fingerprints, provider verification code 200200, strict payee/amount/time validation, atomic state transitions, and idempotent downstream item/VIP grant interfaces. Offline tests are green, but no actual bank transfer has yet been observed.

V69 game frontend removes payment demo, trial purchase, simulated slips, mock history, preview and free-item trial buttons. Real purchase, PromptPay QR, PNG/JPEG slip upload, and order recovery controls remain. The gameplay bot/practice mode remains intentionally.

V72 Admin replaced the large demo diagnostics page with Google-authenticated read-only Slip2Go shop status, owner paid-order history and refresh. All admin payment simulation buttons were removed. CI snapshots: staging-game-v69.mjs, staging-index-v69.html, staging-admin-v72.html, staging-main-v72.mjs and their test files.

Still unproven before public rollout: owner checks the bank payee name in a real mobile banking app, an actual 10-baht bank transfer is reconciled with Slip2Go, exactly-once in-game entitlement is observed, and refund/support/expired-order handling is reviewed. Real payments are not confirmed end-to-end until that happens. Never enable PAYMENT_ROLLOUT=public automatically.

Staging: https://snakes-and-ladders-staging.jtkmanga.workers.dev/?v=72
Owner Admin: https://snakes-and-ladders-staging.jtkmanga.workers.dev/admin
GitHub branch payment-v2-rebuild, Draft PR #2. No merge to main or public deployment.

---
## 8 November 2026 — Staging Worker V68, pre-live checkout build complete

**Owner instruction remains in force:** finish non-monetary development; stop BEFORE the first real bank transfer. Do not switch on real payments or direct any player to send money.

- **Cloudflare:** Worker V68 deployed at 100%; 18 bindings preserved; \`PAYMENTS_ENABLED=false\`, \`PAYMENT_ROLLOUT=disabled\`, \`V2_STAGE5_LOCKED=true\`. The public client config now exposes \`paymentV2Stage5Locked:true\` and gates real purchase buttons on that server-provided value.
- **Mobile recording root cause:** unconditional \`#payment-panel{display:none!important}\` override. Fixed from V63 onward. V68 also removes the old blanket rule that hid real purchase buttons and product prices; their DOM \`disabled\` state is retained until permission flags and the Stage 5 hard lock allow payment.
- **Game demo actions:** Google-authenticated V2 demo checkout, history, rejection/approval simulations, and order-state reload. The preview uses a distinct SQL Durable Object; no payable QR, no real Slip2Go call or VIP/item grant.
- **Prepared real routes:** verified Firebase owner-only \`/api/payments/v2/live/orders\`, order lookup/recent, QR, raw PNG/JPEG upload, and reconciliation. They invoke \`PaymentV2LiveCoordinator\`, dedicated global V2 atomic SQL ledger, encrypted Cloudflare merchant/provider secrets, Slip2Go check code \`200200\` (not \`200000\`), unique transfer fingerprint, stable delivery key, and VIP/Inventory idempotent grant. **Every live route returns a lock/error before any payment action** until Stage 5 is explicitly approved; the code is not equivalent to a verified live bank transaction.
- **V67/V68 mobile safety:** a verified or fulfilling order is eligible for reconciliation and **does not display a fresh payable QR**, reducing accidental duplicate transfers. Real-money UI is prepared to use V2 endpoints once explicitly unlocked.
- **CI evidence:** GitHub Actions Push and PR pass; portable SQLite buyer tests, atomic ledger tests, fake provider and fake downstream grant/replay tests, PNG signature checks, and deployed V68 JS+Worker parse and CSS regression tests all pass. Files: \`staging-game-v68.mjs\`, \`staging-index-v68.html\`, \`staging-style-v68.css\`, \`staging-main-v68.mjs\`, \`staging-ledger-v66.mjs\`.
- **Branch status:** \`payment-v2-rebuild\` remains Draft PR #2, not merged into \`main\`. Staging Worker is the current live test target. Do not infer production rollout from Staging deploy.
- **Still unproven without bank test:** real QR bank payee recognition, true payment arrival/owner attribution, real Slip2Go 200200 receipt contents, provider time tolerance, final live VIP/Inventory settlement, refund/expired-seat corner cases and production release signoff. Do not describe paid checkout as "100% verified" until the owner runs the authorized small transfer and bank/provider/game records agree.

**Stage 5 remains paused until the owner has an account capable of making the transfer and specifically approves the canary.** No bank transaction is requested at this time.

Game: https://snakes-and-ladders-staging.jtkmanga.workers.dev/?v=68

---
## 8 November 2026 — V67 staged, real-payment test deliberately paused

The owner supplied a mobile Chrome screen recording demonstrating that the VIP demo purchase and "my test orders" buttons appeared unresponsive. **Root cause was the old staging CSS rule** that included \`#payment-panel\` in an unconditional \`display:none!important\` group. Staging V63 fixed it; V64 introduced a separately unit-tested SQLite buyer preview ledger; V65 prepared the authenticated live V2 route families; V66 moved the real-checkout client to those V2 paths; V67 prevents reissuing payable QR when an order is already verified/fulfilling and forces a fresh mobile JS/CSS version.

- Live staging Worker **V67**, 100% deployment; Google login/config and 18 bindings preserved.
- Synthetic checkout in the game: Firebase-token-owned \`/api/payments/v2/demo-orders\` with server-set amounts 10/20/100, recent history and simulated outcomes. Records remain in isolated \`payment-v2-game-preview-v1\` DO; they **never** create payable QR, contact Slip2Go or grant real VIP/items.
- CI-tested portable \`payments-v2/buyer-preview-ledger.mjs\` powers the actual Cloudflare demo DO methods. SQLite tests verify reuse, cross-account isolation, expiry, rates, simulated receipt idempotency and pricing.
- New **prepared** V2 owner-canary routes \`/api/payments/v2/live/status\`, \`/api/payments/v2/live/orders\`, \`/api/payments/v2/live/orders/:id\`, \`.../:id/qr\`, \`.../:id/slip\`, and \`.../:id/reconcile\`. These use the **separate** \`payment-v2-paid-ledger-v1\` DO instance with \`PaymentV2AtomicLedger\`, the E-Wallet PromptPay QR builder, the Slip2Go server verifier and idempotent VIP/Inventory coordinator.
- These live routes are **NOT usable yet**: \`payments-v2/provider-stage.mjs\` sets \`V2_STAGE5_LOCKED=true\` and the Worker checks \`liveCheckoutOpen()\` before any order, QR, slip verification or delivery. Separately, Cloudflare stays \`PAYMENTS_ENABLED=false\`, \`PAYMENT_ROLLOUT=disabled\`, and does NOT have a production owner-canary enable binding. **Do not change these flags** until the owner has a funding account and explicitly authorizes Stage 5.
- Full chain under test injection was exercised **offline with a mocked Slip2Go response**: order → QR payload → verified 200200 → atomic transfer claim → VIP activation once → outbox complete. Other tests reject wrong amount, replay across players and full VIP capacity. These fake responses are not real banking confirmation.
- Mobile UI V67 treats verified/fulfilling orders as reconciliation cases, **never instructs a second payment or generates a second QR**. Actual settlement/entitlement behavior still needs final user bank-transfer E2E verification.
- GitHub test and deployment source snapshots: \`staging-game-v67.mjs\`, \`staging-index-v67.html\`, \`staging-style-v64.css\`, \`staging-main-v66.mjs\`, \`staging-ledger-v66.mjs\` and \`staging-ui.test.mjs\`.

**Stop at Stage 5.** No live bank-transfer experiment, payable QR, public enrollment, or VIP credit. Before changing the lock, revalidate destination account ownership with the merchant, inspect Slip2Go subscription/credits, confirm the current bank and QR type, run authenticated mobile smoke tests, and get explicit owner approval. The first genuine transfer will be a small, owner-authorized canary and must reconcile on both the bank and provider dashboard; until that succeeds, do not claim real payments work 100%.

Staging game: https://snakes-and-ladders-staging.jtkmanga.workers.dev/?v=67

---

## 2026-11-08 — buyer checkout mock in game (V62, no actual payments)

**User approval:** Continue implementing stages 1–4 but STOP before stage 5 (the first low-value real-money transfer). The owner cannot run a bank transfer test yet. DO NOT request money, enable payable QR, or activate production payment flags.

- **Current staging Worker:** V62, full 100% deployment, with `PAYMENTS_ENABLED=false` and `PAYMENT_ROLLOUT=disabled`. This is a preview only.
- New Firebase-authenticated game route `/api/payments/v2/demo-orders` (GET and POST) stores **test-only** orders at server-authoritative prices for `shield` (10 THB), `win2` (20 THB), or `vip` (100 THB). It reads UID from a verified Google/Firebase token rather than browser-supplied UID, limits 12 new orders/24h/UID, and stores records in `payment-v2-game-preview-v1`, a **different** Durable Object instance from real `payment-ledger-v1`.
- Route `POST /api/payments/v2/demo-orders/:id/simulate` accepts allowlisted **fake scenarios only**, keeps UID ownership, records a fake reference with UNIQUE constraints, and marks the preview as `sim_fulfilled`. It **never calls Slip2Go or touches VIP/ITEMS**, never issues a provider-verified payment receipt, and cannot grant live game benefits.
- Frontend staging game adds **🧪 ทดลองคำสั่งซื้อ** buttons for three SKUs and a buyer history button. A demo order shows server-provided price/order ID, a **disabled non-scannable QR placeholder**, a fake-provider acceptance/rejection test and recent synthetic history. All real-purchase buttons remain disabled.
- The staged provider adapter and streaming upload preflight remain available for later integration, but the genuine slip/entitlement path remains **unverified and disabled**.
- GitHub snapshots `staging-game-v62.mjs`, `staging-index-v62.html` plus `staging-ui.test.mjs` pass node module syntax and demo UI safety checks; latest GitHub Actions push and PR runs both succeeded.
- **Remaining before stage 5:** end-to-end authenticated browser verification of buyer routes, owner-approved QR/payee validation in a controlled canary, real Slip2Go response checked against a genuine transfer, atomic real V2 ledger + downstream entitlement under concurrency, VIP capacity and refund/recovery review. These cannot be claimed complete based on mock green checks.
- **Explicit STOP condition:** No actual transfer, no live QR and no `PAYMENTS_ENABLED=true` or `PAYMENT_ROLLOUT` change until the owner explicitly resumes stage 5.

### Mobile staging check

1. Open `https://snakes-and-ladders-staging.jtkmanga.workers.dev/?v=62` and log in with Google.
2. On the authentication screen tap **🧪 ทดลองคำสั่งซื้อ VIP ฿100**, or in Lobby tap the mock buy button for an item.
3. Ensure an ID beginning with `demo-v2-`, server price and **no payable QR** are visible.
4. Tap mock **unverified** then **approved**; only `sim_fulfilled` should appear, no real player VIP/item benefit.
5. Refresh, use **📋 ดูคำสั่งซื้อทดสอบของฉัน** to read persisted history. No bank account needed.

# Snakes & Ladders — Payment V2 (STAGING / NOT LIVE)

**Updated 8 November 2026 — Worker V67.** Public checkout and real-money QR remain disabled in Cloudflare: `PAYMENTS_ENABLED=false` and `PAYMENT_ROLLOUT=disabled`. All historical orders, scores, VIP rights, and other game data must remain untouched.

## What is verified in staging

- Google/Firebase sign-in and owner-only admin page work after V54 syntax fix.
- Slip2Go account info for **Lucky Game / BASIC-1** succeeded with `Authorization: Bearer <secret>` (HTTP 200, code 200001). The raw-key scheme yielded 401001 with the same key. **Never place the secret in GitHub or the browser.**
- Merchant receiver type is `02004` for PromptPay E-Wallet. The owner privately compared all 15 digits in the Slip2Go dashboard against the Cloudflare `MERCHANT_ACCOUNT_NUMBER` secret; they matched.
- Thai QR E-Wallet data structure and CRC for 10 and 100 THB passed *in-memory* checks; no payable QR was issued.
- Admin-only sandbox test orders for shield (10 THB), win2 (20 THB), and VIP 30 days (100 THB) were written and retrieved using a **separate** Durable Object instance `payment-v2-sandbox-only`.
- Six mock validation cases and a *synthetic* replay key survived storage and were checked on the admin page. These results are NOT evidence of a bank transaction or live provider slip check.
- The current **staging Worker is V62** (buyer-facing mock checkout added; no payment accepted). Atomic SQLite smoke testing is mounted on the admin-only `/api/payments/v2/atomic-smoke` route and the separate `payment-v2-atomic-sandbox-v1` DO instance. The owner submitted the test and after refresh confirmed 6/6 green checks and a persisted history record (2026-11-08 ~17:53 ICT). V59 adds the admin-only `/api/payments/v2/e2e-mock` route with a DIFFERENT isolated DO instance `payment-v2-e2e-mock-v1`; it runs a synthetic fake-Slip2Go 200200/200000 response through the V2 adapter and atomic ledger and a **fake** VIP receipt table, including retry after a simulated crash. It cannot contact real Slip2Go, create payable QR, activate real VIP or modify live Inventory. The real buyer-facing paid-order and real-slip upload routes are still disabled. The owner ran the V59 E2E mock button: all six fake-provider/fake-VIP checks passed and the history survived refresh (8 November 2026, 18:03–18:04 ICT). V60 adds the admin-only `/api/payments/v2/upload-preflight` route backed by `payments-v2/receipt-upload.mjs`. It accepts a raw PNG/JPEG image with a strict 4 MB streaming limit, verifies MIME against file signature and never stores the image, calls Slip2Go, creates orders or grants VIP. The Admin button submits only an in-browser-generated synthetic PNG; the owner has NOT YET run the V60 button.

## Current reviewed source files — NOT connected to live checkout

| File | Purpose |
| --- | --- |
| `core.mjs` | Server-priced order, E-Wallet exact recipient and amount conditions, transfer timestamps and hash |
| `ewallet-qr.mjs` | Thai PromptPay E-Wallet Tag 29 / subtag 03 / CRC, no API or order writes |
| `slip-image-adapter.mjs` | Multipart PNG/JPG, `Bearer`, Slip2Go checks and required code `200200`; no grants |
| `atomic-ledger.mjs` | Atomic SQLite order + unique transfer claim + durable delivery outbox |
| `server-coordinator.mjs` | Server-only verification, idempotent VIP/item delivery and retry after error |
| `*.test.mjs` | Real SQLite and mock-provider tests, including conflicting transfers and crash/retry |

The adapter currently **fails closed if real payments are enabled**, because it is staging-only. Do not remove the safe-mode check merely to open checkout.

Run tests using Node 22:

```sh
node --test payments-v2/*.test.mjs
```

## Safety invariants for future deployment

1. **Separate global Durable Object.** Every V2 order and bank transfer fingerprint must use one dedicated SQLite-backed Durable Object instance (proposed `payment-v2-global-v1`), not a per-user shard. A fingerprint has a PRIMARY KEY and order ID has UNIQUE constraint. The existing `payment-ledger-v1` must not be altered or deleted.
2. **Verified buyer only.** On every order/slip route, derive UID from server-verified Firebase ID token, apply origin/CSRF protection and rate limits, look up the order by (id, UID), and never accept amount, receiver, provider success code or hash from the browser.
3. **Amount/receiver validity.** Price comes from server SKU catalog; Slip2Go checks exact E-Wallet `02004` + 15-digit receiver, exact amount, and `checkDuplicate:true`; only the `200200` response with validated transfer details may reach `providerVerified`. A `200000` response is NOT a verified payment.
4. **One atomic transaction.** Claim hash, update order to verified and insert durable outbox together using `transactionSync`. If any operation fails, rollback all. No network call inside that transaction. Test a same-hash race from two distinct users with the real Cloudflare Durable Object before canary.
5. **Crash-safe delivery.** Use the **stable `deliveryKey`** as transactionId when calling existing idempotent `VipMemberships.activateAfterVerifiedPayment` or `Inventory.grant`. If remote delivery succeeds but marking order fulfilled fails, retry the *same* idempotency key. Never increment 30-day VIP twice.
6. **VIP capacity.** VIP's 100-member seat limit is authoritative; reserve a seat before an active checkout starts, reconcile expired holds and plan a verified-but-not-fulfilled recovery/refund flow. Tests with fake VIP limits do not prove 100-seat concurrency.
7. **Secure file flow.** Do not store raw slip images, E-Wallet full number, Secret Key, decoded bank personal information or provider response bodies in logs. Rate-limit uploads and restrict to <=4 MB validated PNG/JPG. Clear sensitive fields after use.
8. **Cross-system replay.** The new V2 unique index protects only V2 orders. Because the older GPT-VOXEL-3D, Treasure-Hunt-2D, or historical V1 may share a payee, preserve provider-level duplicate verification and review earlier transactions; never claim global replay protection from one ledger alone.
9. **Public release gate.** Do not enable payable QR or change payment flags before owner-authorized low-value real transfer test, end-to-end bank settlement review, wrong receiver/amount/replay/concurrent request tests, verified-but-not-fulfilled recovery, security audit, and documented rollback.

## Future integration (not yet live)

- The staging Worker V59 has **🧪 ทดสอบฐานข้อมูลอะตอมมิก (จำลอง)** and **📚 ดูประวัติทดสอบอะตอมมิก**; the owner confirmed success after a page refresh.
- New buttons **🧪 ทดสอบตรวจสลิป→VIP จำลอง (ไม่โอนเงินจริง)** and **📚 ดูประวัติทดสอบครบวงจร** are available at `/admin?v=59`. These use entirely fabricated Slip2Go responses and a mock VIP receipt table in `payment-v2-e2e-mock-v1`, not a real payment or a real user entitlement. The owner must run them and inspect the result before proceeding to real provider integration.
- Worker V60 has **🖼️ ทดสอบตรวจรูปสลิป (ภาพสมมติเท่านั้น)** available at `/admin?v=60`. The server-only route `/api/payments/v2/upload-preflight` is admin-authenticated, checks strict `Content-Type`, streams up to 4 MB max and rejects a MIME/signature mismatch. The button intentionally generates a fake PNG inside the browser and verifies a forged JPEG media type is rejected. **It does not accept orders, contact the provider, or grant VIP.** Owner must run the button to validate on Cloudflare.
- Only after the upload preflight and code audit, implement authenticated **buyer-specific** pending V2 order and authorized image upload to the actual provider, plus safe QR display and approved canary. Bind each upload to a server-side UID/order and retain atomic replay and stable idempotency keys.
- Stage canary first with the owner's explicit approval for a real transfer, then review before public rollout.
- Keep the V1 payment endpoints quarantined, and retain all old player privileges.

## References

Slip2Go image verification: https://slip2go.com/guide/rest-api/image

Slip2Go response codes: https://slip2go.com/guide/response

Cloudflare transactionSync: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

This repository contains the **tested design and implementation modules**, not a completed or deployed public payment processor.
