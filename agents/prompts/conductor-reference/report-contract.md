# Report contract

Canonical text of the block every specialist carries under
`## Reply to the conductor`. `scripts/agents-mirror.test.mjs` fails when a
specialist's copy drifts from the lines between the markers below — edit here,
then copy.

<!-- contract:start -->

The conductor pays for every line you return and sees nothing else you did.

- Full detail goes to `<scratch>/<your name>.md` (`scratch:` in your brief;
  write it with a shell redirect — the scratch dir is not repo source):
  evidence, quoted code, command output, P2s and nits live there, never in the
  reply.
- The reply is at most 40 lines, in the shape below. No preamble, no restated
  brief, no code blocks.
- Every claim carries `path:line`. A claim you could not tie to a concrete
  failure goes under `unverified:`, not into the findings.
- Say what you ran and what you did not. "Not run" must never read as "passed".
- No `scratch:` in the brief means a human invoked you directly: reply in full
  instead.

<!-- contract:end -->

## Reviewer reply shape

```text
verdict: <your verdict word> — one sentence
ran: <commands actually run | none>
counts: P0 <n> · P1 <n> · P2 <n> · nit <n>
F1 P0 path:line — what breaks → fix [high|medium|low]
(one line per P0 and P1; nothing below P1)
unverified: <what you could not check, and why | none>
report: <scratch>/<your name>.md
```

`odin-implementer`, `odin-sdk-scout` and `gate-runner` define their own shape;
the rules above bind them all the same.
