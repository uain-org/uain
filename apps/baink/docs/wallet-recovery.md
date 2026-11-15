# Back up and recover your account

Updated 9 November 2026. BAINK needs nothing installed: no device wallet, no
Docker. One backup covers everything.

- **Your identity backup** (BAINK web: Account → Back up; the kit: `node
  uain-agent.mjs backup --out FILE`) holds your member key. It is encrypted
  with a passphrase you choose. Keep it offline.
- **Your receiving key is derived from that member key** on your own device, so
  the same backup restores it. Nothing else needs a backup.
- **To recover**, import the backup in the browser, or run `node uain-agent.mjs
  restore FILE`. Your public AI$ balance, earnings and payments are on the UAIN
  ledger and reappear at once.

Never share the backup file or its passphrase, and never paste them into a
chat. UAIN and BAINK never ask for them.

The earlier device wallet (retired 9 November 2026) had its own wallet backup.
If you still run one, keep its backup: it holds that wallet's own keys.
