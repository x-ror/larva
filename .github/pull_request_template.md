<!--
Title: type(scope): imperative summary   e.g. perf(url): 2.8x faster basicURLParse
Run /pr-gate before requesting review.
-->

## What changed

<!-- One paragraph. What behavior exists now that did not before. -->

## Reuse verdict

<!-- What you did NOT write, because core:/vendor:/an already-linked C library or an
in-repo helper covers it. For anything hand-rolled, the evidence for rejecting the
existing candidate (file:line + the disqualifying behavior). "N/A — no new native
logic" is a valid answer. -->

## Node parity

<!-- Which user-visible surfaces changed, and how parity was verified (the probe
script and the node-vs-lava diff). Any deviation from Node: what it buys, where it
is commented, and the Lava-only test that pins it. -->

## Performance

<!-- Required for perf(...) changes and any hot-path work: make bench / make
bench-http output, or a profile. Delete this section only if nothing perf-relevant
was touched. -->

## Gates run

<!-- Paste results. See agents/prompts/pr-gate-reference/gates.md for what the
changed paths require. Networking smokes run on both backends. -->

- [ ] `make check`
- [ ] `make check-js` (if JS changed)
- [ ] `make check-md` (if any `.md` changed)
- [ ] `make check-actions` (if a workflow changed)
- [ ] `make build`
- [ ] `make test` / `make test-lava`
- [ ] routed smokes: <!-- list -->
- [ ] `make bench` (if perf claimed)

## Tests

<!-- New oracle cases, Odin tests, or smokes — and what each would catch on a
revert. If known-lava-gaps.txt or bench/thresholds.json was widened/loosened, the
reason. -->

## Docs

- [ ] Non-obvious decisions (lifetimes, probes, thresholds, deviations) commented at the site
- [ ] `docs/ARCHITECTURE.md` / `docs/LARVA.md` / `README.md` / `make help` updated where the change triggers it
