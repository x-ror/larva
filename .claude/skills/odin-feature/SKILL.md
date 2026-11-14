---
name: odin-feature
description: >
  Implementation pipeline for Lava/Larva work, conducted from the session and
  executed by workers — profile, reuse scout, oracle-parity design (Node or
  Chrome), TDD, gates. `--fix` closes pr-gate findings or red gates.
argument-hint: '<what to build> [--no-scout] [--design-only] [--issue N] | --fix [findings file]'
---

# /odin-feature

Canonical playbook: [agents/prompts/odin-feature.md](../../../agents/prompts/odin-feature.md)
Conductor protocol: [agents/prompts/conductor.md](../../../agents/prompts/conductor.md)
SDK map: [agents/prompts/odin-feature-reference/odin-sdk-map.md](../../../agents/prompts/odin-feature-reference/odin-sdk-map.md)

## Hard rules

1. You conduct: profile and design are yours; probes, the SDK sweep, code and
   gates go to the workers the playbook names. Do not skip the reuse scout.
2. Never run a gate or read a diff body in this session — `gate-runner` and the
   reviewers return tables, the logs stay on disk.
3. `--fix`: findings in, `odin-implementer` in fix mode, two rounds at most,
   no P1 waived, no scope beyond the findings.

## After implement

Hand off to `/pr-gate`. PR is created only after pr-gate succeeds.
