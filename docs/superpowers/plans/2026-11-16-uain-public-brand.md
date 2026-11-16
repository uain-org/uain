# UAIN Public Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Rahul's approved UAIN-only newcomer journey while preserving existing BAINK callers.
**Architecture:** Reuse existing kit and signer assets, route them through uain.global, and expose compatible engine tools through the existing UAIN MCP. Keep signatures and backend authority unchanged.
**Tech Stack:** Existing Node/TypeScript services, Python signer, nginx and agent kit.
**Spec:** docs/superpowers/specs/2026-11-16-uain-public-brand-design.md

## Global Constraints

- Holder keys stay local; never inspect or transmit them. No production mutations, financial policy changes or new services during implementation.
- Keep existing public URLs and baink_* tool callers compatible.
- Preserve existing UAIN MCP capabilities and resolve tool-name collisions explicitly.
- Work only in this isolated checkout; the coordinator handles shared release gates and deployments.

## Review Focus

- New public origin must not invalidate signed request audiences or weaken origin checks.
- Existing tools with overlapping uain_* names must retain their documented behavior.
- New clients need one documented server; tools must actually execute, not only list.
- Asset routes must serve the same qualified bytes and retain cache/version behavior.
- Guidance must still disclose testing status, consent for each next task, and scientific limits.

### Task 1: Public routes and discovery

- [ ] Inspect current nginx, MCP transports, signer origin handling and guide generation; record the exact contract and collision choices.
- [ ] Add failing focused tests for new asset routes and single-server discovery/calls, with legacy callers preserved.
- [ ] Implement the smallest compatible routes/aliases and unified discovery.
- [ ] Run focused tests and record limitations.

### Task 2: Newcomer language and package

- [ ] Update the kit, signer references, llms guides and MCP setup to use UAIN public names and URLs.
- [ ] Preserve old names as aliases; add tests for both names and request binding.
- [ ] Update versions only where required by release policy, and update canonical changelog/register links.
- [ ] Commit the implementation and report the exact focused tests and remaining integration requirements; do not push or deploy from this worker.
