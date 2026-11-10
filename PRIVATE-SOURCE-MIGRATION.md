# Private Worker Source Migration — V99 (not public)

**Status:** Source privacy audit completed; this branch installs a local-only export tool.
A dedicated private GitHub repository cannot be created through the GitHub connector currently available in this chat. Do not upload the Worker source to this public repository.

## Cloudflare snapshot evidence

The deployed `snakes-and-ladders-staging` Worker is version `69c8e428-cd8c-4106-be91-ccc00cdf3e1e` (V99) and contains **24 modules**. A read-only scan found four modules containing historical payment references and/or personal information:

- `main.js`
- `static.js`
- `payments-v2/owner-item-recovery.mjs`
- `payments-v2/owner-historical-recovery.mjs`

This is an **initial conservative scan**, not proof the other modules are fit for public release.

## How to export safely (Codespaces / local Node 22)

1. First create a dedicated **private** GitHub repository named `Snakes-and-Ladders-Private`. Keep its visibility **Private**.
2. Use a local Codespaces terminal and a short-lived **read-only Cloudflare Workers Scripts** API token. Do **not** paste the token into chat, source, issues, or workflow logs. Cloudflare token creation is a manual account action.
3. Run the exporter from a checkout of this public repository, specifying an output directory *outside* that checkout:

```bash
export CF_API_TOKEN='(paste privately in the terminal only)'
export CF_ACCOUNT_ID='(your Cloudflare account ID)'
node scripts/export-private-worker.mjs --output ../snakes-private-snapshot
unset CF_API_TOKEN
```

4. The exporter **refuses CI**, **refuses output inside the public checkout**, verifies exactly deployed **V99**, validates 24 filenames, writes restrictive filesystem permissions, and produces SHA-256 checksums plus warnings for sensitive modules. It never changes Cloudflare resources.
5. **Do not run `git add` on the raw snapshot.** Review all 24 modules and move customer-specific payment history to protected storage. Replace those hardcoded values with secure references before committing to the private repository. This snapshot intentionally has `.gitignore` that blocks accidental additions.
6. After sanitizing, import the modules into the private repository. Configure private CI using synthetic test records; keep Cloudflare secrets in GitHub Actions Secrets (not in files), use manual deployments with rollback.

## Release-gate follow-up

The public `quality.yml` continues with **read-only** checks. True unit tests of current V99 require the **sanitized, private source of truth**; the older `payment-v2-rebuild` GitHub branch contains historical tests but is not current V99. No developer should claim V99 game-engine coverage based solely on those older tests.

**Never** disable Slip2Go anti-replay, reuse historical transfers, or submit customer payment files through CI.
