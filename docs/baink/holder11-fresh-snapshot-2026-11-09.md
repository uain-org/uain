# Holder11 fresh snapshot — 9 November 2026

Public holder release sequence11 is available at https://baink.money/wallet/. Source1aee510c89e0049bf1fb19da7fb7046bca57745e. Same holder signing public key and image/native tools/pins as sequence10; no secret export or key rotation.

- Signed manifest SHA256: `19760d0339c18a8fd0211710253ad7a63fbee0e3cdf4e3858f60ed1d1eaeefb8`,55files.
- Typed approval SHA256: `f3f43f88528cf4716d6c9a368d40406abbb669e180431f062656caa094734aaa`.
- Snapshot URL: https://baink.money/wallet/bootstrap/ledger-dbs-d99ddac0ba518bcf4077f9d43d7713b5872d4580fab717739240fc62beb33e14.tar.gz
- Snapshot SHA256: `d99ddac0ba518bcf4077f9d43d7713b5872d4580fab717739240fc62beb33e14`,1013052411bytes.
- Snapshot node height1391005, header09:11:57UTC; independently pinned reader authenticated height1391004 in an isolated non-validator using the same genesis/tools. Historical qualification used a larger age budget only for that offline snapshot check; payment/runtime proof freshness remains unchanged.

## Publication and rollback

The root-reviewed publisher guarded exact previous manifest10 `9b9cb0a97a88bc4617217ba26a803788f9fa19a31c87febd7fc637d531e02a61` under the shared BAINK activation lock. It verified a staged55-file public delta, retained history/tool bytes using immutable hardlinks, verified signatures and full snapshot stream hash, then atomically promoted `/var/www/baink-wallet/current` to `releases/11-19760d0339c18a8f`. HTTP acceptance failures restore the prior pointer inside the same lock. Prior release10 remains for controlled rollback; a client with sequence11 will reject an older sequence, so use a forward signed release for general client recovery.

## Limits

Installing a signed runtime is not a database refresh. Existing initialized ledgers remain intact under the ordinary installer. Local node-only refresh requires its separately reviewed maintenance procedure and rollback, preserving keys/config/journals. Publication does not establish caught-up state, current spendability, or any completed payment. The new producer reports informational progress with fresh local proof before caughtUp=true; the combined UI expires that status and keeps polling. No financial actions occurred in this publication.
