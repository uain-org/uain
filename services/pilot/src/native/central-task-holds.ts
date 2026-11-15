/** Copy of apps/baink/server/central-task-holds.json, BAINK's operator work
 * holds. The pilot image is built from services/pilot only, so it cannot read
 * the BAINK file; test/native-central-discovery.test.mjs fails when this copy
 * differs from that file. A hold only hides a task from public discovery while
 * its exact task, project, criteria and evidence digests and the pinned chain
 * match; it changes no native state or monetary term. */
export const CENTRAL_TASK_HOLDS={
 "schema": "baink-central-task-holds-v1",
 "chainId": "uain-shadow-20261008-1",
 "genesisSha256": "54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff",
 "holds": [
  {
   "taskId": "T-OPP-00004-1-prior-art-survey",
   "projectId": "P-OPP-00004",
   "criteriaDigest": "974467198acbdb8a7ae7c09bc221bd2462debbf7715ee63db9ac5f52868ca0f7",
   "evidenceDigest": "4df46dea35a68a28879e17ee53d50049cd37989f07f1dd327af8894df5197de2",
   "reason": "task_specification_unusable",
   "evidence": [
    "https://api.crossref.org/works/10.35802%2F323586",
    "https://api.crossref.org/works/10.1016%2Fs0262-40791530636-9"
   ]
  },
  {
   "taskId": "T-OPP-00005-1-prior-art-survey",
   "projectId": "P-OPP-00005",
   "criteriaDigest": "c284b37fd25056912e4f6a41820b76986efc060590465c3aaae403eb9354c732",
   "evidenceDigest": "0c1d5d58aac0de7223129741b4667b0174f4d72952b7a35ef8852b958e003df3",
   "reason": "task_specification_unusable",
   "evidence": [
    "https://api.crossref.org/works/10.54499%2F2024.03713.bdana"
   ]
  },
  {
   "taskId": "T-OPP-00006-1-prior-art-survey",
   "projectId": "P-OPP-00006",
   "criteriaDigest": "8b15e9fdfac5ccbbc1c235662631e4b69eb7fffe41e1298daf8d082f6b5d13ba",
   "evidenceDigest": "3ae997a9c37d82674147c13c08c8b5d265a67ec4be5434fa27b2c64f1dc24b20",
   "reason": "task_specification_unusable",
   "evidence": [
    "https://api.crossref.org/works/10.67599%2Fanr-20-ce18-0001"
   ]
  },
  {
   "taskId": "T-OPP-00007-1-prior-art-survey",
   "projectId": "P-OPP-00007",
   "criteriaDigest": "ed6da97c87ee59cbdec90905d77551d708344271e8133fac44b3422d973d95dc",
   "evidenceDigest": "7f554c06135f3a9d378e02b39ae549cc3989ab717a26ac0de79ed5b53ea2d04c",
   "reason": "task_specification_unusable",
   "evidence": [
    "https://api.crossref.org/works/10.1016%2Fs1937-64481830076-5"
   ]
  }
 ]
} as const;
