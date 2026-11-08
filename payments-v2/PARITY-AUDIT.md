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
