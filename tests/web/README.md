# Window-profile oracle suite

The oracle for anything a page can reach is output **recorded from Chrome**
([CLAUDE.md](../../CLAUDE.md) §1, §6; [x-ror/larva#2](https://github.com/x-ror/larva/issues/2)).
This suite is the first slice of that corpus: Web API cases that used to be
compared against Node in `tests/node-compat` and `tests/runtime/eventloop`,
rewritten as page scripts and recorded in headless Chrome.

```sh
make test-web                       # every case under bin/lava vs its recording
make record-web CASES="url-parse"   # re-record (needs google-chrome; CHROME_BIN overrides)
node scripts/run-web-oracle.mjs --update-known <case>   # re-pin a known gap's Lava output
```

## A case

`cases/<area>-<topic>.js` is a classic script. It reports through one global,
`print(value)`, which writes `String(value)` and a newline; nothing else it does is
observed. `ORIGIN` is the fixture server's origin (`/fx/text`, `/fx/json`,
`/fx/echo`, … in [scripts/lib/web-oracle.mjs](../../scripts/lib/web-oracle.mjs)); print
paths relative to it, never the port.

- **No Node names**: no `require`, `process`, `Buffer`. Lava runs the case with
  `lava run`, which does not define them, and the `globals-window` case pins that
  against Chrome.
- **No `'use strict'` directive** at the top: Lava's one-line prelude goes in
  front of the case's first line (so stack line numbers match Chrome's), and that
  would turn the directive into a plain expression. Put strict code in a function.
- **Print only what is stable**: no timings, random values, ports or stacks. Print
  booleans for bounds, and `JSON.stringify` strings that may hold lone surrogates.
- **Report errors, do not throw them**: an uncaught error is a page error, which
  the recorder refuses and the runner fails. Print `e.constructor.name`; print a
  message only in a case that is about messages (`*-errors.js`), because those are
  where Lava still differs.
- **End on its own**: Chrome runs the case under virtual time and dumps the page
  when the budget is spent. A case whose callbacks spin on the clock (virtual time
  freezes it inside a task) records in real time instead: add
  `// web-oracle: real-time <ms>` with the wall-clock time it needs.

`cases/<case>.expected` is the recording: a header (Chrome version, date, how many
runs agreed, the command that re-records it), `# ---`, then Chrome's bytes. The
recorder runs every case three times in fresh profiles and writes it only if all
runs agree and none raised a page error. Never edit one by hand.

## Shape cases

`cases/shape-<family>.js` print what a page reads off each Web API global without
calling it — descriptors, names, lengths, own keys, constructibility and the
`Function.prototype.toString` text of the global, its statics and every prototype
member, in own-key order (#114). They are generated: edit
[scripts/gen-web-shape.mjs](../../scripts/gen-web-shape.mjs) (its `FAMILIES` table
lists the globals each case covers), run `node scripts/gen-web-shape.mjs`, then
re-record. `make check-js` fails when a case and its generator disagree. The members
are enumerated at run time, so a member either side adds is caught without a
generator change. `shape-missing` lists the Chrome globals of those families Larva
lacks; `shape-tostring` and `shape-stacks` are written by hand.

## Known gaps

[known-gaps.txt](known-gaps.txt) lists the cases where Lava does not print what
Chrome did, as `<case> <stage>: <reason>`. Each is held to its current Lava output,
pinned in `known/<case>.lava`, so a gap that changes fails as surely as a new
mismatch, and one that starts matching Chrome fails until its entry and pin are
removed. The stage names the step of the Node-profile removal that closes it:

| Stage       | Changes                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `S2`        | Web globals install from the internal modules, not from Node modules          |
| `S4a`       | shared modules throw `TypeError`/`RangeError`/`DOMException` with Chrome text |
| `S4b`       | encoding without `buffer` or Node errors                                      |
| `S4c`       | blob, file and structured clone without `Buffer`/`process`                    |
| `S4d`       | fetch bodies and streams                                                      |
| `S4e`       | url: Chrome's messages                                                        |
| `S5b`       | the Window surface becomes the only one                                       |
| `unplanned` | no stage closes it; it needs an issue of its own                              |
