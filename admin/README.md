# Snakes & Ladders — Game Admin V80

Live Staging admin: https://snakes-and-ladders-staging.jtkmanga.workers.dev/game-admin

Standalone mobile-first Admin HTML with a Google-login allowlist and verified Firebase ID tokens. The legacy Payment Admin at /admin remains available.

Player registry:
- The Free and VIP boards use separate SCORE Durable Objects.
- New Google-authenticated player heartbeats occur every 30 seconds while in lobby/game; an account is considered online for 90 seconds after its last heartbeat.
- Existing leaderboard top-50 is migrated on board initialization. Older non-leader accounts that had not been indexed by the previous game version appear after playing or a new score event.
- Admin can edit nickname and points, not Google UID/email. Changes are audited.
- Score awards are idempotent by room and award type using transactional SQLite.

Resets:
- VIP: every day at 00:00 Asia/Bangkok.
- Free: every Sunday at 00:00 Asia/Bangkok.
- One alarm per board DO, initialized on first board read. Each reset captures the top player's score, name, UID, and available email before clearing scores.
- Manual reset requires two UI confirmations and the explicit server-side RESET value; it does not shift scheduled alarms.
- The dashboard shows winner history, next reset, and audit events.

Pricing:
- Owner-only editing of VIP (default 100 THB), shield (10), and win2 (20), each integer 1 to 5000 THB.
- The real Payment V2 DO stores the price map; newly created orders freeze their amount for verification and QR. Old pending/paid orders retain their exact old amount.
- Game prices refresh every 60 seconds and new checkout uses the authoritative server price.

Security:
- Admin APIs require a verified Firebase Google ID token, server allowlisted email and same-origin check. No user-controlled UID, score or amount is trusted.
- Payment remains owner-only canary and is NOT opened to all players by Admin deployment.
- Changes are deployed to Staging Worker V80, 100 percent. Branch payment-v2-rebuild is still Draft PR #2, not main.

Test automation runs both Payment V2 and Admin suites, covering Thai reset boundaries, scoreboard SQL and replay protection. Mobile-browser login and actual online score editing still require an on-device smoke test.

Game: https://snakes-and-ladders-staging.jtkmanga.workers.dev/?v=admin-board-v78
