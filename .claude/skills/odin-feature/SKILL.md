---
name: odin-feature
description: >
  Implementation pipeline for Lava/Larva work — profile, reuse scout,
  oracle-parity design (Node or Chrome), TDD, gates.
argument-hint: '<what to build> [--no-scout] [--design-only] [--issue N]'
---

# /odin-feature

Canonical playbook: [agents/prompts/odin-feature.md](../../../agents/prompts/odin-feature.md)
SDK map: [agents/prompts/odin-feature-reference/odin-sdk-map.md](../../../agents/prompts/odin-feature-reference/odin-sdk-map.md)

## When you run interactively

Follow the playbook in `agents/prompts/odin-feature.md` (profile → scout →
design → red tests → implement → verify). Do not skip the reuse scout.

## After implement

Hand off to `/critic` then `/pr-gate`. PR is created only after pr-gate succeeds.
