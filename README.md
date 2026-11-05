# Snakes & Ladders v0.5 — Auth, Anti-cheat & Slip2Go integration

## Status (5 November 2026)

This is a **staging implementation**, not live production. Code and tests are ready for review, but Firebase sign-in will not work until the owner enables Google provider and supplies Firebase web settings. Payment is **disabled by default**, and no transfer can be credited or initiated until the merchant receiving account and Slip2Go API key are verified, and live testing is complete.

## Game rules preserved

- 3 players per room, 20-second roll, skip when timed out, roll 1–6.
- Reaching **or passing 100** wins (+10); `win2` doubles ONLY win bonus (+20); Lucky Box is not multiplied.
- Exactly one Lucky Box per room, only exact landing: 10 points (50%), 50 (30%), 100 (19%), 500 (0.9%), 1,000 (0.1%).
- Shield absorbs one snake per game; 10 avatars and smooth tile-by-tile animation.
- Free Server open to all authenticated players, VIP limited to **100 active members** at ฿100 / 30 days.
- Paid items: win2 ฿20 / 24h; shield ฿10 / 24h.

## Firebase prerequisites (on mobile)

1. Firebase Console → **Snakes and Ladders** project → Build → Authentication → **Sign-in method** → **Google** → Enable; select support email → Save.
2. Project settings → General → Add app → **Web** (if not already) → note the Web SDK `firebaseConfig` fields `apiKey`, `authDomain`, `projectId`, `appId`.
3. Authentication → Settings → Authorized domains → add the **exact deployed game host** (`snakes-and-ladders-staging.<your-subdomain>.workers.dev`) after staging deployment. Do not use a wildcard or the old voxel game domain.
4. Configure the new Cloudflare Worker with `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`. Set via Cloudflare dashboard Worker Settings → Variables or `wrangler secret put <NAME>`; never share secrets/keys in chat, GitHub PR or browser-side logs. The Firebase Web API key is public configuration, **not** a privileged Admin private key.
5. The Worker validates Google Firebase ID tokens with public signing keys, matching `aud`, `iss`, expiry, UID, and Google provider. A Firebase Auth sign-in is *not* an authorization to modify score, VIP or purchases.

## Slip2Go live payment prerequisites

1. In Slip2Go → **API Connect** → **Authentication** create/check the Secret Key. The application uses a server-only `Authorization` header, never expose that key in HTML/JS.
2. Confirm **the actual account receiving the money** and its bank/PromptPay `accountType` and exact `accountNumber` matching Slip2Go's documented `checkReceiver` conditions. Test that a screenshot from any *different* receiving account is denied.
3. Set in Cloudflare **server settings** (not GitHub):
   - Secret `SLIP2GO_SECRET`
   - `SLIP2GO_API_BASE_URL` — **exact verified HTTPS API origin** from the dashboard; no guessed hostnames; must belong to Slip2Go domain
   - Variables/Secrets `MERCHANT_ACCOUNT_TYPE` (e.g. `01004` for KBANK; use actual receiving type)
   - `MERCHANT_ACCOUNT_NUMBER` exact account number (as required by Slip2Go `checkReceiver`)
   - Optional `MERCHANT_ACCOUNT_NAME_TH` to further constrain receiver
   - Public display fields `MERCHANT_DISPLAY_NAME` and `MERCHANT_PUBLIC_ACCOUNT` (shown to payers, so configure only the approved receiving details)
4. Keep `PAYMENTS_ENABLED` **false** until a real low-value end-to-end transfer is observed, confirmed via Slip2Go dashboard, the returned verified amount/recipient is checked, the duplicate receipt attempt is rejected, and entitlement grant/reconciliation behavior is verified.
5. To enable after tests, change only the Worker `PAYMENTS_ENABLED` variable to `true` and deploy again with an explicit go-live decision.

**Note:** Slip2Go is a *verification provider*, not a payment acquirer. It checks that a transfer to your account exists. Funds must actually arrive at your designated bank account. The photo and API Secret are not stored in client storage or a public database.

## Important backend security design

- `GET /api/config` exposes only public Firebase configuration, payment availability and public merchant transfer details (when enabled).
- `POST /api/match` requires Firebase bearer token and derives identity from verified `uid`; the client cannot submit player IDs, VIP status, rolls or entitlements. Room tickets are random and expire after 2 minutes.
- The Worker sends random dice, Lucky Box draws, winner +10/+20 score, and item effects from authenticated server state; room-scoped score credits are idempotent.
- All orders are bound to a verified Firebase UID and server-side product price. `PaymentLedger` stores orders, guards concurrent verifications, and enforces global uniqueness of a SHA-256 fingerprint of the bank transfer + QR reference.
- Slip2Go verification requires provider code `200200`, matching amount, an actual bank transfer reference and QR, recent transfer timestamp, provider `checkDuplicate`, exact receiver conditions and exact server-created amount. No status from browser can cause a paid grant.
- If the payment is verified but entitlement activation fails, it stays `verified` for authenticated `/api/orders/:id/reconcile`. **Do not pay twice.** Expired VIP hold may require manual refund/review.
- All payments are **off** if any required merchant setting is missing; no hardcoded merchant banking details or live API Secret.
- Keep Firebase Security Rules locked (no client writes to privileged scores/VIP/items); Firebase is used as identity provider, Cloudflare Durable Objects are game source-of-truth.
- CAPTCHA/App Check, anti-abuse, worker request limits, account deletion/data-retention policy and independently witnessed live payment tests are required before public release.

## Security checklist before production

- [ ] Google login works on the actual staging URL on a real mobile browser.
- [ ] Access without bearer token gets HTTP 401 for `/api/me`, `/api/match`, `/api/orders`.
- [ ] Tokens of another Firebase project, expired or tampered tokens fail.
- [ ] Backend ignores fake score, fake VIP and fake paid item values.
- [ ] Free and VIP queues/rankings are separate. VIP 100-member limit is server-side.
- [ ] Correct slip, wrong amount, wrong receiver, old slip, tampered slip, duplicate slip and concurrent duplicate attempts are tested against Slip2Go.
- [ ] Verify purchase item expiry, VIP expiry, renewals and order status after any Worker restart.
- [ ] Run WebSocket tests with three authenticated devices, then load tests and quotas.

## Run checks

```bash
npm install
npm run check
npx wrangler dev
```

Don't deploy with payment enabled during initial setup. Local offline demo: `public/demo-offline.html` (still demo without live Google or real purchases). The **online page** `public/index.html` uses Firebase only if the backend config is present.

### References
- https://firebase.google.com/docs/auth/admin/verify-id-tokens
- https://slip2go.com/guide/authentication
- https://slip2go.com/guide/rest-api/image
- https://slip2go.com/guide/response
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/