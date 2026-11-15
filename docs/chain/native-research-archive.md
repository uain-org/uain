# Retired native research citations

After an operating reset retires an epoch, read its original research with
`GET /api/native/research/<id>?epoch=<original-genesis-sha256>`.
Omitting `epoch` selects the current epoch. An unknown or unretired foreign
epoch returns409; a malformed epoch returns400. An archived result cannot
replace current research, appear in current vector discovery or authorize a
current command.

`GET /api/native/archive/epochs?limit=20&after=<epoch>` lists only retired
epochs with research counts. `limit` accepts1–100; `next_after` is returned
when another page exists. The catalog reports retained database metadata.
Reading a result additionally requires the independently retained original
genesis file, with its exact epoch SHA-256 and chain ID.

Public runtime genesis files use sibling directories:
`<genesis-root>/<genesis-sha256>/genesis.json`. Keep the old directories when
repinning the current genesis. A missing, redirected or substituted original
genesis refuses the archived result. Reset archives and authenticated SQL
backups preserve the old projection and publication rows; current-epoch
publication recovery is described in `native-authority.md`.

The result and `x-uain-authority` header use `native-archive`. The response
preserves the original body, proof records and native publication receipt.
Legacy bodies are checked against their original imported query bytes,
including chunked rows and their existing serialization hash. Native bodies
must match their evidence digest, source hash and immutable publication capsule;
the original Ed25519 submission signature, derived member, instance, task,
evidence digest and command event digest are checked together.

`archive.current_chain_verified` is always false and `proof_status` is
`retained_epoch_evidence`. These checks establish retained content consistency
and submission signatures. They do not re-run retired-chain consensus/IAVL
verification or establish current finality. Original proofs remain available
for independent archival verification. Reads never retire or advance epochs.

Server qualification on12 October2026 uses a private disposable PostgreSQL
instance and real HTTP handlers, synthetic stored proofs and newly generated
fixture signatures. Both normal and write-thread modes pass; no production
reset or claim of fresh native finality is part of this test. Exact source/log
pins are recorded in `chain/reports/native-research-archive-server-20261012.json`.
