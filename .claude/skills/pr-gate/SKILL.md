---
name: pr-gate
description: >
  Hard merge gate — mechanical gates + specialist review, conducted from the
  session and executed by workers → SHIP/SHIP-AFTER/BLOCK. Required before any PR.
argument-hint: '[--local | --branch <name> | --pr <n>] [--quick | --review-only]'
---

# /pr-gate

Canonical playbook: [agents/prompts/pr-gate.md](../../../agents/prompts/pr-gate.md)
Conductor protocol: [agents/prompts/conductor.md](../../../agents/prompts/conductor.md)
Gates: [agents/prompts/pr-gate-reference/gates.md](../../../agents/prompts/pr-gate-reference/gates.md)
Scoring: [agents/prompts/pr-gate-reference/scoring.md](../../../agents/prompts/pr-gate-reference/scoring.md)

## Hard rules

1. `gate-runner` compiles first (`make check` / `make build` fail → **BLOCK**, no reviewers).
2. Fan out the routed reviewers from `agents/specialists/` in one message.
3. Rule on every P0/P1 from the cited lines; list what you rejected and why.
4. Never self-waive a P1 — SHIP-AFTER is the ceiling when one is open. Merge is always human.
5. Open a PR **only** after SHIP or SHIP-AFTER from this gate.
6. This command never edits the tree; fixes go through `/odin-feature --fix`.
