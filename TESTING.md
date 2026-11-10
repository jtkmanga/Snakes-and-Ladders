# Snakes & Ladders — Safe Test Gates

This repository is **public**. Do **not** commit Cloudflare Worker bundles, Firebase ID tokens, transaction IDs, customer identifiers, payment QR codes, merchant wallet numbers or provider credentials. The deployed Worker currently contains historical owner payment-recovery data and needs an explicit private migration and sanitization review before source publication.

## What is tested

| Layer | Trigger | Scope | Non-goal |
| --- | --- | --- | --- |
| Offline API contracts | Every PR and push to main | Local Node schema/URL assertions | Not a game-engine unit test |
| Live read-only smoke | Nightly 07:15 Thailand + manual | Public endpoints and anonymous access rejection | No multiplayer joining, no writes |
| Deployed-source audit | Nightly + manual **with secrets configured** | Downloads deployed modules in-memory; checks critical code guards | No external mutation and no source exported |
| Bounded HTTP smoke | Explicit manual checkbox only | HTTPS `/api/health`, 4 RPS for 3s by default | NOT a 10,000-player or WebSocket load test |

## Operating on a phone

1. Open GitHub Actions in this repository; select **Staging Quality Gates (no deployment)**.
2. Use **Run workflow** to trigger read-only smoke. Leave `run_load_smoke` unchecked unless you want the limited HTTP load test.
3. Inspect green/red jobs and their logs; a green result does not imply 10K multiplayer capacity.
4. To enable the optional source audit, add a **read-only**, narrowly scoped Cloudflare API token in GitHub **Actions secrets** as `CF_API_TOKEN` and the account ID as `CF_ACCOUNT_ID`. Never paste tokens into issue bodies, PRs, logs or ChatGPT chats.

## Remaining release blockers

- True game-engine tests must import the real Worker modules from a **private** source repository or secure CI artifact, rather than copying production payment history to this public repo.
- Playwright/mobile E2E with two **dedicated staging test users**, safe test identities and separate test-only payment provider are not implemented. Do not put owner/admin Firebase credentials in CI.
- Full paid-order paths require a Slip2Go sandbox/mock with strict replay/wrong-amount/wrong-receiver cases; the live smoke job deliberately cannot charge or grant entitlements.
- 10,000 simultaneous player / Durable Objects / WebSocket capacity requires dedicated load infrastructure and a separately approved test window. The bounded smoke here measures only small-volume HTTP availability.
- Implement a reviewed, manual promotion pipeline for production later. **This workflow never deploys anything.**


## Real deployed V99 rules tests (optional)

A dedicated read-only test script `npm run test:deployed-rules` fetches only the
actual Cloudflare `rules.js` module, verifies the **active Worker version** and
**SHA-256**, then executes **21 synthetic game-rule cases in memory**. It checks:
five boards, snakes, ladders, finish-line overshoot, VIP/free player counts,
20-second turns, shield, win multiplier, Lucky Box probabilities and excluded
squares. It never joins real rooms or writes payments, scores, or user profiles.

This job is part of the nightly/manual `source-audit` job. It **skips**
until both `CF_API_TOKEN` and `CF_ACCOUNT_ID` Actions Secrets are configured
with **read-only Workers script content** permission; do not interpret a skipped
test as passing. It fails closed if Worker V99 is upgraded without reviewing
and repinning the expected module hash. No deployed source is committed.
The separate **real WebSocket / browser E2E / 10K concurrency tests remain pending**.

## One-time live HTTP baseline — 10 November 2026

The public Staging quality workflow [run #42821717002](https://github.com/jtkmanga/Snakes-and-Ladders/actions/runs/42821717002) sent 15 **read-only** real `GET /api/health` requests over 5 seconds (3 RPS, maximum 2 concurrent). **15/15 succeeded, 0 failures, P95 322 ms** on the GitHub-hosted runner. No WebSocket, login, payment or score mutation was performed. The one-off PR job was then removed; normal scheduled/manual read-only checks remain.

This is a small HTTP availability baseline, **not** evidence of capacity for 10,000 live players, 3,334 live rooms, Cloudflare bill, or WebSocket reconnects. Real multiplayer tests require an isolated test Worker and separate synthetic authentication/DO namespaces.
