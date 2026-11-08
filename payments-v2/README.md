# Snakes & Ladders — Payment V2 (STAGING / NOT LIVE)

**Updated 8 November 2026 — Worker V59.** Public checkout and real-money QR remain disabled in Cloudflare: `PAYMENTS_ENABLED=false` and `PAYMENT_ROLLOUT=disabled`. All historical orders, scores, VIP rights, and other game data must remain untouched.

## What is verified in staging

- Google/Firebase sign-in and owner-only admin page work after V54 syntax fix.
- Slip2Go account info for **Lucky Game / BASIC-1** succeeded with `Authorization: Bearer <secret>` (HTTP 200, code 200001). The raw-key scheme yielded 401001 with the same key. **Never place the secret in GitHub or the browser.**
- Merchant receiver type is `02004` for PromptPay E-Wallet. The owner privately compared all 15 digits in the Slip2Go dashboard against the Cloudflare `MERCHANT_ACCOUNT_NUMBER` secret; they matched.
- Thai QR E-Wallet data structure and CRC for 10 and 100 THB passed *in-memory* checks; no payable QR was issued.
- Admin-only sandbox test orders for shield (10 THB), win2 (20 THB), and VIP 30 days (100 THB) were written and retrieved using a **separate** Durable Object instance `payment-v2-sandbox-only`.
- Six mock validation cases and a *synthetic* replay key survived storage and were checked on the admin page. These results are NOT evidence of a bank transaction or live provider slip check.
- The current **staging Worker is V59**. Atomic SQLite smoke testing is mounted on the admin-only `/api/payments/v2/atomic-smoke` route and the separate `payment-v2-atomic-sandbox-v1` DO instance. The owner submitted the test and after refresh confirmed 6/6 green checks and a persisted history record (2026-11-08 ~17:53 ICT). V59 adds the admin-only `/api/payments/v2/e2e-mock` route with a DIFFERENT isolated DO instance `payment-v2-e2e-mock-v1`; it runs a synthetic fake-Slip2Go 200200/200000 response through the V2 adapter and atomic ledger and a **fake** VIP receipt table, including retry after a simulated crash. It cannot contact real Slip2Go, create payable QR, activate real VIP or modify live Inventory. The real buyer-facing paid-order and real-slip upload routes are still disabled. The owner has NOT YET run the V59 E2E mock button.

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
- Only after tests, implement authenticated buyer endpoints for pending V2 orders, QR display and slip upload; wire server coordinator to provider and dedicated global ledger; use existing VIP/Inventory idempotent methods.
- Stage canary first with the owner's explicit approval for a real transfer, then review before public rollout.
- Keep the V1 payment endpoints quarantined, and retain all old player privileges.

## References

Slip2Go image verification: https://slip2go.com/guide/rest-api/image

Slip2Go response codes: https://slip2go.com/guide/response

Cloudflare transactionSync: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

This repository contains the **tested design and implementation modules**, not a completed or deployed public payment processor.
