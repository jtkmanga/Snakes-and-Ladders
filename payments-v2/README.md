# Snakes & Ladders — Payment V2 rebuild (NOT LIVE)

Status: UNDER DEVELOPMENT — NO REAL MONEY, NO PUBLIC CHECKOUT.

The original payment routes were disabled on Cloudflare staging Worker v37 on 2026-11-08.
The historical Durable Object order ledger and existing player entitlements are intentionally preserved.

## What is being rebuilt

1. **Buyer:** Verified Firebase Google ID token; never trust UID from request body.
2. **Order:** New unguessable order ID, fixed SKU/amount only on server, 15-minute checkout window.
3. **PromptPay QR:** Create a QR for each order with exact amount and a merchant-owned payee. The uploaded Thai QR was a static QR without amount; ownership must be independently confirmed.
4. **Receipt:** PNG/JPG uploaded only against the authenticated buyer's order.
5. **Provider:** Slip2Go checks duplicate transfer, exact recipient and amount. Require response code 200200, not merely 200000; repeat amount and time checks on server.
6. **Atomic ledger:** Store a hash of transfer reference under a unique index in a Durable Object; duplicate transfer cannot pay two orders.
7. **Entitlements:** Grant VIP or items only after verification, once per transaction. Enforce VIP maximum 100 members using server-side coordination.
8. **Recovery:** Verified-but-not-fulfilled orders stay retriable; prevent accidental second payment.
9. **Admin:** All diagnostics restricted to allowlisted Google identity, never expose secrets or full bank data.
10. **Release gate:** Fresh provider key only in Cloudflare secret SLIP2GO_V2_SECRET; PAYMENTS_V2_ENABLED defaults to false until full testing passes.

## Isolation

Use a separate Durable Object instance named payment-ledger-v2, while keeping payment-ledger-v1 and prior VIP rights for audit/reconciliation. Before accepting new payments, verify duplicates across both systems and the Slip2Go provider. Do not delete past payment evidence.

Legacy payment APIs are quarantined. The live /api/payments/v2/status route reports setup status and acceptingPayments=false.

## Tests

With Node 22: node --test payments-v2/core.test.mjs

The pure code in core.mjs and its tests cover server-authoritative product prices, invalid orders, required provider checks, mismatch/fake slips, timestamp limits, deterministic transfer fingerprint and merchant preflight.

## Still required

- Confirm that the PromptPay payee encoded in the supplied QR belongs to the intended merchant.
- Resolve fresh provider Authentication using GET /api/account/info with a new secret never placed in chat.
- Implement and audit V2 order storage, authenticated routes, QR issuance, slip verification, fulfillment, idempotency and recovery.
- Test concurrent replay, wrong amounts, transfer time limits, seat limit 100/100, retries and one permitted 10-THB real-money canary.
- Only then consider enabling payments for others.

Slip2Go reference: https://slip2go.com/guide/rest-api/image
Account info: https://slip2go.com/guide/rest-api/account-info
Response codes: https://slip2go.com/guide/response

IMPORTANT: These files are V2 groundwork; they do not implement a live payment processor.
