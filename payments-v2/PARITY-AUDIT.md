## 2026-11-08 15:32 ICT — persistent mock replay test and provider adapter (NO live payment)

- On the admin page, the owner confirmed all six synthetic replay checks pass: mock valid, duplicate transfer, wrong amount, wrong receiver, unverified slip, expired order.
- An isolated V2 Sandbox Durable Object saved one synthetic transaction and returned a record after the admin refreshed. This does not establish successful payment verification or replay prevention in a real cross-user concurrent payment race.
- The live Worker remains a test-only stage. No real Slip2Go slip has been submitted and no real QR/paid order or VIP entitlement was created during this test.
- New GitHub files `payments-v2/slip-image-adapter.mjs` and `payments-v2/slip-image-adapter.test.mjs` implement and test a **not-yet-deployed** Slip2Go image API adapter. It uses the pinned `POST /api/verify-slip/qr-image/info` endpoint, observed `Bearer` auth, multipart PNG/JPEG (4 MB max), precise E-Wallet `02004` receiver, `checkDuplicate: true`, `checkAmount: eq`, rejects `200000` (found is not paid), and only returns a fingerprinted event for `200200`. This adapter cannot grant VIP and refuses to operate outside safe disabled-payment mode.
- CI on commit `ad3582851b7b346cc3a83ad7d557aa4b1edfe40f` succeeded for both push and pull request validation.
- **Still to implement before Public**: real V2 pending-order lifecycle, authorized buyer-specific upload and verified provider call, atomic unique-fingerprint transaction ledger under concurrency, idempotent inventory/VIP grant, QR receiving-bank settlement confirmation, canary with approved actual payment and recovery logic, final security review and rollback policy. Do not treat a mock validation or code-only test as proof of live payment readiness.

## Verified provider access and remaining receiver-account gate — 2026-11-08

The real owner-only comparison on the staging Worker returned:
- `Authorization: SECRET` → HTTP 401 / provider `401001`
- `Authorization: Bearer SECRET` → HTTP 200 / provider `200001`
- The subsequent Payment V2 owner preflight (Worker v46) succeeded, with merchant **Lucky Game**, package **BASIC-1**, 86.75 tokens and about 347 slip checks (as shown in the 14:40 ICT test).
- The staging Worker remains `PAYMENTS_ENABLED=false` and `PAYMENT_ROLLOUT=disabled`. No QR/checkout was enabled by this patch.
- These observations establish *provider authentication and merchant account-readiness only*. They do NOT establish payment receiver ownership, QR validity, bank settlement, slip verification, anti-replay or VIP fulfillment.

### Mismatch requiring owner confirmation before any QR

The staging bindings include `MERCHANT_ACCOUNT_TYPE=02001` (phone-number PromptPay) and secret `MERCHANT_ACCOUNT_NUMBER`. A previous Slip2Go receiver-account settings screenshot showed an E-Wallet identifier rather than a phone number. The screenshot is not proof they are different accounts, but the mismatch in account **type** must be resolved before QR or real transfers.

Release gate requirements:
1. Verify the EXACT receiving PromptPay account and type via the merchant's own banking app / provider dashboard, privately. Do not send full identifiers or QR-embedded personal data to a public repository.
2. Verify that the QR generator encodes that same intended account and exact order amount.
3. Create a new V2 order with server-controlled price and authenticated Firebase identity.
4. Verify a real slip against exact receiver, exact amount and unique bank transfer reference, then atomically grant the entitlement once.
5. Test a 10-THB canary end to end and confirm settlement to the intended account, including refunds/failure recovery, before enabling public purchases.
6. Keep legacy transactions and existing VIP rights intact; maintain a separate V2 ledger / anti-replay registry.

# Payment V2 parity audit — 2026-11-08

Scope: compare the current GitHub source of GPT-VOXEL-3D and Treasure-Hunt-2D against the previously inspected live Cloudflare Snakes & Ladders Worker. This report does **not** prove any public payments succeeded.

## Grounded findings

| Aspect | GPT-VOXEL-3D (GitHub main) | Treasure-Hunt-2D (GitHub main) | Snakes & Ladders (Worker v44 inspected) |
| --- | --- | --- | --- |
| Payments implemented | Code for hosted Slip2Go PromptPay QR and slip check | NO; offline prototype explicitly states no Slip2Go payments | Legacy local PromptPay QR + Slip2Go slip check, now disabled for V2 rebuild |
| Provider authorization | Authorization: Bearer + env.SLIP2GO_API_SECRET | Not applicable | Authorization: env.SLIP2GO_V2_SECRET (as server V2 override) |
| First tested endpoint | POST /api/qr-payment/generate-qr-image-link | None | GET /api/account/info |
| Documented success code | 200 for QR generation | None | 200001 for merchant account info |
| Observed screenshot | 401002 Shop not found on QR generation | No screenshot confirming real payment | 401001 Token Mismatch on account-info |
| Merchant receiver | PAYMENT_RECEIVER_ACCOUNT + type in Worker | None | PromptPay receiver settings in Worker; V2 payments disabled |

Sources:
- GPT-VOXEL-3D/src/worker/http.mjs (handlePaymentQr)
- GPT-VOXEL-3D/tests/rebuild/slip2go-auth.test.cjs (explicitly asserts Bearer format)
- Treasure-Hunt-2D/README.md (offline prototype statement)
- Slip2Go official authentication: https://slip2go.com/guide/authentication
- Slip2Go official account info: https://slip2go.com/guide/rest-api/account-info
- Slip2Go official QR link: https://slip2go.com/guide/rest-api/promptpay-qr-url
- Slip2Go response codes: https://slip2go.com/guide/response

Official authentication documentation says the Authorization header VALUE should equal the Secret Key itself; it does not instruct using Bearer. Therefore the old game's Bearer prefix should **not** be treated as a verified fix. Both 401001 and 401002 are errors, not proof a payment API is ready.

## Safe confirmation design

- Keep live PAYMENTS_ENABLED=false and PAYMENT_ROLLOUT=disabled.
- Wire this folder's auth-diagnostic.mjs into an **admin-only** Worker route behind verified Google identity and same-origin request validation, e.g. GET /api/payments/v2/auth-parity.
- The helper first tries the officially documented raw Secret Key. Only when it receives 401001, it issues a second read-only request to the same pinned URL with the old Bearer scheme. It returns only sanitized HTTP/code results. It does not create QR, authorize payment, or grant VIP.
- Ensure account-info response is 200001 *and* the expected merchant identity/quota is validated before changing any payment flags.
- Remove the temporary Bearer diagnostic after resolving the discrepancy. Keep the documented scheme for real processing unless Slip2Go support supplies authoritative updated guidance.
- If the documented scheme continues returning 401001 for a recently generated key, contact provider support with timestamp and HTTP/code only; never send keys in chat, issue comments, screenshots, or pull requests.

## Live deployment state

The Payment V2 source is a **draft**, not yet integrated into the live Worker. The Cloudflare connection was unavailable at the time of this audit; no live Worker deployment was performed as part of the comparison. The most recently confirmed live state remained V44, with real payments disabled.
