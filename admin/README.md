# Snakes & Ladders — Game Admin V81

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
- Changes are deployed to Staging Worker V81, 100 percent. Branch payment-v2-rebuild is still Draft PR #2, not main.

Test automation runs both Payment V2 and Admin suites, covering Thai reset boundaries, scoreboard SQL and replay protection. Mobile-browser login and actual online score editing still require an on-device smoke test.

Game: https://snakes-and-ladders-staging.jtkmanga.workers.dev/?v=admin-board-v78


## V81 Admin additions

- **Global player ban/unban:** The verified owner can ban by Firebase UID, with a required moderation reason. The banned account is blocked from both Free and VIP matchmaking, from new room WebSocket connections, and from rolling in an existing room on its next roll. The moderator cannot ban their currently signed-in administrator UID. No score, VIP membership, or inventory record is destroyed by a ban. Every action is audited.
- **Per-server maintenance mode:** Owner can turn off new matchmaking for Free or VIP independently. Existing running game rooms can finish. Maintenance does not change the payment system. Default at install is OFF for both.
- **VIP transaction history:** Owner-only, read-only paging against the existing Payment V2 paid ledger, filtered to VIP purchases. Only masked order ID, masked buyer UID, amount, provider-verified delivery state and timestamps are surfaced. No slip, transaction hash, receiving account, or provider API secret is returned. Historical V1 and synthetic test orders are deliberately excluded.
- **Score backup/export:** Owner-only, paginated JSON or CSV download per server. Includes stored Firebase UID, registered email, nickname and score. JSON also includes available winner reset history. Files are downloaded to the browser; no automatic backup schedule or restore function is enabled yet. Excel formula-injection is escaped for CSV. The export is drawn from live records in pages and is not an atomic point-in-time snapshot if scores change during download.

## API additions

- GET /api/admin/control/status
- GET /api/admin/control/bans?limit=50&offset=0
- GET /api/admin/control/audit
- POST /api/admin/control/ban
- POST /api/admin/control/maintenance
- GET /api/admin/payments/vip?limit=50&offset=0
- GET /api/admin/board/export?server=free&offset=0&limit=250
- GET /api/server/status (public maintenance booleans only)

All admin routes require the signed, email-verified Google owner and same-origin request; mutations are POST only. Ban/maintenance checks happen on the server and do not depend on browser UI.
