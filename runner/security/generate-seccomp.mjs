// SPDX-License-Identifier: Apache-2.0
// Docker's upstream policy remains the baseline. Pin its bytes before adding
// only the syscalls needed by bubblewrap inside an unprivileged user namespace.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

const source = 'https://raw.githubusercontent.com/moby/profiles/2ceae35d351c156cb5a8efc0fdc4a08cf94569d8/seccomp/default.json';
const expected = '6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6';
const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(20000) });
if (!response.ok) throw new Error(`Docker policy download: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Docker policy checksum refused');
const policy = JSON.parse(bytes);
policy.syscalls.push({ names: ['unshare', 'mount', 'umount2', 'pivot_root', 'sethostname', 'setdomainname'], action: 'SCMP_ACT_ALLOW' });
// Keep Docker's ordinary clone filters and clone3 ENOSYS fallback. The extra
// clone rule applies only when CLONE_NEWUSER (0x10000000) is requested.
policy.syscalls.push({ names: ['clone'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value: 0x10000000, valueTwo: 0x10000000, op: 'SCMP_CMP_MASKED_EQ' }] });
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node generate-seccomp.mjs /absolute/path/codex-seccomp.json');
await fs.writeFile(destination, JSON.stringify(policy, null, 2) + '\n', { mode: 0o644 });
console.log(`Generated Codex seccomp policy from pinned Docker source ${expected}`);
