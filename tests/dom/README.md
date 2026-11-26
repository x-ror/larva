# DOM oracle suite

The parser and serializer behind `lava html` and `lava fetch` are checked against
output **recorded from Chrome** ([CLAUDE.md](../../CLAUDE.md) §1, §6;
[docs/LARVA.md](../../docs/LARVA.md) decision 1, roadmap stage 3a). The suite
shares its recording format, known-gap rules and Chrome driver with the Window
suite ([tests/web](../web/README.md)); what is specific to it lives in
[scripts/lib/dom-oracle.mjs](../../scripts/lib/dom-oracle.mjs).

```sh
make test-dom                         # every case under bin/lava vs its recording
make record-dom CASES="void-elements" # re-record (needs google-chrome; CHROME_BIN overrides)
node scripts/run-dom-oracle.mjs --update-known <case>   # re-pin a known gap's views
```

## A case

`cases/<area>-<topic>.html` is an HTML input, UTF-8 without a BOM (the recorder
refuses anything else: charset handling is stage 3c and is recorded through
navigation, not here). Its bytes reach both parsers unchanged — `.gitattributes`
keeps git from normalizing a CRLF case. Chrome parses it with
`new DOMParser().parseFromString(input, 'text/html')` from a trusted harness page;
a DOMParser document has scripting disabled, as `lava html` does, so `<noscript>`
parses as markup.

`cases/<topic>.frag-<context>.html` is a fragment case: Chrome sets the input as
the `innerHTML` of a `<context>` element created in a no-quirks DOMParser document,
and Lava runs `lava html --fragment <context>`. A foreign context is named
`frag-svg-<local>` or `frag-math-<local>` (`frag-svg-foreignObject`) and created
in its namespace; `lava html` refuses those until stage 3e.

Each case has two **views**, compared byte for byte and judged apart:

- **tree** — `lava html --tree`: the html5lib tree-construction format, one line
  per node or attribute, `|` plus two spaces per depth. Elements print as `<name>`,
  or `<svg name>` / `<math name>` in foreign content; attributes as `name="value"`
  one level deeper, `xlink href="…"` when namespaced; a template's content as a
  `content` line, its children one level deeper still; text as `"data"`; comments
  as `<!-- data -->`; a processing instruction as `<?target data>` (Chrome 158
  parses `<?php x ?>` into one); a doctype as `<!DOCTYPE name>`, with `"public" "system"` when
  either id is non-empty. One departure from html5lib: attributes keep the
  element's order instead of being sorted, because the parser must reproduce it.
- **serialize** — `lava html --serialize` (the default output): the document's
  children serialized in order — a doctype as `<!DOCTYPE name>`, a comment as
  `<!--data-->`, a processing instruction as `<?target data?>`, an element as its
  `outerHTML` — then one newline. For a fragment
  case, the context element's `innerHTML` and a newline.

`dumpTree` and `serializeDocument` in `scripts/lib/dom-oracle.mjs` are the
definitions; `pkg/html/dump.odin` is the Lava side of the tree and
`pkg/html/serialize.odin` of the serialization.

`cases/<case>.expected` is the recording: the header (Chrome version, date, how
many runs agreed, the command that re-records it), `# ---`, then `#tree`, the
dump, `#serialize`, the markup. The recorder writes it only if three runs in fresh
profiles agree and the harness threw in none. Never edit one by hand.

## The html5lib corpus

`cases/html5lib-<file>-<NNN>[.frag-<context>].html` are generated, one per test,
from the html5lib-tests tree-construction inputs vendored in
[html5lib/](html5lib/) (MIT, see [NOTICE](../../NOTICE); commit 9329e64, the last
before those tests moved to web-platform-tests). `NNN` is the test's place in its
`.dat` file. Chrome records them like any other case: html5lib's own expected trees
are **not** the expectation, only a cross-check.

```sh
node scripts/gen-html5lib-cases.mjs                # regenerate the inputs from html5lib/*.dat
node scripts/record-dom.mjs --jobs 10 html5lib-    # record all of them (a few minutes)
node scripts/gen-html5lib-cases.mjs --cross-check  # Chrome's trees vs html5lib's
```

Never edit a generated case: `scripts/gen-html5lib-cases.test.mjs` (in
`make check-js`) fails when the committed cases differ from what the `.dat` files
generate. Left out, and printed by every generator run: the 8 `#script-on` tests
(a DOMParser document has scripting off, so Chrome cannot record them here; stage 4
pages parse with scripting on) and `tree-construction/scripted/`, which runs
script. The case-count floor holds the hand cases; the generator test holds the
corpus to its inputs and the inputs to a floor of their own.

The cross-check when the corpus landed: 1778 of 1784 trees agree with html5lib's.
The 6 that differ are Chrome's to decide: 4 `<?…>` inputs Chrome 158 parses as
processing instructions where html5lib expects bogus comments, a `template`
context whose children Chrome puts in the content (empty `childNodes`), and a
`select` context where Chrome keeps `<input>`.

## Known gaps

[known-gaps.txt](known-gaps.txt) lists the views where Lava does not print what
Chrome did, as `<case>.<view> <stage>: <reason>` — `void-elements.serialize 3b: …`
— so a serializer gap does not excuse the tree. Each is held to its current Lava
output, pinned in `known/<case>.<view>.lava`: a gap that changes fails, and one
that starts matching Chrome fails until its entry and pin are removed. The stage
is the step of the DOM plan that closes it:

| Stage       | Changes                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `3b`        | tree read API mirror, Odin serializer, html5lib corpus                     |
| `3c`        | charset sniffing, fetch end to end, public-site corpus                     |
| `3d`        | selectors (matches, closest, :scope, Chrome's invalid-selector set)        |
| `3e`        | Document and mutation API, fragment parsing into a live tree               |
| `3f`        | shadow DOM and declarative shadow roots                                    |
| `3g`        | XPath                                                                      |
| `3h`        | same-origin frames                                                         |
| `unplanned` | no stage closes it (a lexbor parser divergence); needs an issue of its own |

When stage 3b landed, all 120 hand-case views and 3440 of the 3568 html5lib views
matched Chrome 158 (96.4%). The 128 listed are 126 views of fragments for an SVG or
MathML context (`3e`) and one `select`-context case where lexbor's parser drops an
`<input>` Chrome keeps (`unplanned`).
