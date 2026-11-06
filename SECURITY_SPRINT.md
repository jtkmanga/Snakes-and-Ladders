# Snakes & Ladders — Multiplayer Security Sprint (6 November 2026)

## Delivered (staging only)
- Idempotent matchmaking for the same Google UID; a retry reissues a seat ticket instead of reserving multiple slots.
- Existing-room rejoin with ticket rotation.
- Partially filled waiting rooms expire after 120 seconds.
- Active rooms close only after **three consecutive skipped turns without a successful dice roll** (3 × 20 seconds ≈ 60 seconds). Each valid roll resets the skipped-turn counter, even when the other one or two players are disconnected.
- Rooms with no connected WebSockets coalesce their alarms until the no-roll deadline (three turns); reconnecting does not extend the clock or reset the skip counter.
- Closed rooms reject rejoin tickets and users can match into a new room.
- Previously earned Lucky Box score is retried on transient scoreboard errors, including while the room becomes idle.
- Game dice and leaderboard awards remain controlled by Durable Objects. No client-provided dice or score accepted.

## Automated checks
- Local Node test suite: **46/46 passing in GitHub Actions**, including server-authoritative roll, duplicate score prevention, VIP cap, and payment input checks.
- Browserless offline **10,000-player game model**, covering 3,334 rooms. This models rules/CPU only, not actual 10,000 simultaneous WebSockets or Cloudflare quota.
- Staging Cloudflare deployment successful; Google Firebase bindings present; `PAYMENTS_ENABLED=false`.

## Release gates remaining
1. Repeat a three-account real-phone test after the latest code change: join, timeout, disconnect/rejoin, room expiry and rankings.
2. Validate scoring under real WebSocket disconnects and verify all unauthorized API routes fail.
3. Confirm Slip2Go business receiving-account, API endpoint and secret (store in Cloudflare Secrets, **never in GitHub or chat**) and perform authorized real-payment canary before enabling public payment.
4. Replace the single global lobby/scoreboard DO bottlenecks with a scale-ready approach before a 10K online load test.
5. Budget the Workers/DO request and alarm quotas. 10,000 24/7 online players cannot currently be guaranteed free of charge.

## Important deployment detail
Cloudflare Staging was deployed via the Cloudflare API with a small static-file router and Firebase variables supplied through Worker bindings. The repository's `wrangler.jsonc` expects the Workers Static Assets binding and does not include these Firebase variables. A blind `wrangler deploy` could replace staging configuration; use an intentional deployment process.

Production and payment remain disabled. No live 10K load was run.
