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
and Lava runs `lava html --fragment <context>`.

Each case has two **views**, compared byte for byte and judged apart:

- **tree** — `lava html --tree`: the html5lib tree-construction format, one line
  per node or attribute, `|` plus two spaces per depth. Elements print as `<name>`,
  or `<svg name>` / `<math name>` in foreign content; attributes as `name="value"`
  one level deeper, `xlink href="…"` when namespaced; a template's content as a
  `content` line, its children one level deeper still; text as `"data"`; comments
  as `<!-- data -->`; a doctype as `<!DOCTYPE name>`, with `"public" "system"` when
  either id is non-empty. One departure from html5lib: attributes keep the
  element's order instead of being sorted, because the parser must reproduce it.
- **serialize** — `lava html --serialize` (the default output): the document's
  children serialized in order — a doctype as `<!DOCTYPE name>`, a comment as
  `<!--data-->`, an element as its `outerHTML` — then one newline. For a fragment
  case, the context element's `innerHTML` and a newline.

`dumpTree` and `serializeDocument` in `scripts/lib/dom-oracle.mjs` are the
definitions; `pkg/html/dump.odin` is the Lava side of the tree.

`cases/<case>.expected` is the recording: the header (Chrome version, date, how
many runs agreed, the command that re-records it), `# ---`, then `#tree`, the
dump, `#serialize`, the markup. The recorder writes it only if three runs in fresh
profiles agree and the harness threw in none. Never edit one by hand.

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

When this suite landed every view matched Chrome 158, so the list is empty.
