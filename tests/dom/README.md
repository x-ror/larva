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
refuses anything else: other bytes are a navigation case, below). Its bytes reach both parsers unchanged — `.gitattributes`
keeps git from normalizing a CRLF case. Chrome parses it with
`new DOMParser().parseFromString(input, 'text/html')` from a trusted harness page;
a DOMParser document has scripting disabled, as `lava html` does, so `<noscript>`
parses as markup.

`cases/<topic>.frag-<context>.html` is a fragment case: Chrome sets the input as
the `innerHTML` of a `<context>` element created in a no-quirks DOMParser document,
and Lava runs `lava html --fragment <context>`. A foreign context is named
`frag-svg-<local>` or `frag-math-<local>` (`frag-svg-foreignObject`) and created
in its namespace; `lava html` refuses those until stage 3e.

`cases/<topic>.nav.html` and `cases/<topic>.nav-<label>.html` are **navigation
cases** (stage 3c): bytes in any encoding, decoded the way a page load decodes them.
The recorder serves them from its local server as `text/html`, or as
`text/html; charset=<label>`, into a `sandbox="allow-same-origin"` frame of a
harness page and reads the frame's document (`navPage` in
`scripts/lib/dom-oracle.mjs`): the sandbox keeps scripting off, as in `lava html`,
and a CSP keeps every subresource on the machine. The harness is served as
windows-1252, which an unlabeled same-origin frame inherits, and which is also what
Chrome 158 gives an unlabeled top-level page, so the frame decodes as a direct
navigation would. Lava runs `lava html --sniff` (or `--charset <label>`): the
encoding sniffing algorithm over lexbor's encoding module (`pkg/html/encoding.odin`)
— BOM, then the transport label, then the `<meta>` prescan, then windows-1252.
`charset-*` cases each pin one step; `make test-fetch-html-smoke` serves some of
them to `lava fetch` behind a redirect and a content coding, against the same
recordings.

`cases/<topic>.page.html` are **scripted page cases** (stage 4a): a page with
scripting on, whose views are of the document after its scripts ran. The recorder
serves the bytes as `text/html; charset=utf-8` into an unsandboxed frame of a harness
page (`scriptedPage` in `scripts/lib/dom-oracle.mjs`), under a CSP that allows the
case's inline scripts and same-origin external ones and blocks every other subresource,
and reads the frame's document at its load event. Lava runs `lava page
--tree|--serialize`: the same bytes parsed with their classic scripts run as HTML runs
them (`pkg/runtime/page_script.odin`), DOMContentLoaded fired, the event loop run until
it idles, `load` fired. A case reports by writing into its own document (a
`<pre id="log">` it appends text to), never through `console`, which `lava page` prints
to stdout ahead of the view. It must finish its work by the load event: no timer whose
callback changes the tree. The `dom-*.page` cases cover the DOM surface stage 4 binds
(`pkg/runtime/dom.odin`, `pkg/runtime/js/internal/dom.js`).

A page case's **external scripts** (`dom-script-*.page`, #13) are sibling files in
`cases/`, named after the case (`<topic>.page.<n>.js`): `<script src="x.js">` resolves
against the frame's URL, `/raw/<topic>.page`, to `/raw/x.js`, which the recorder serves
from `cases/x.js` (`pageScript`); `lava page` resolves the same `src` against the case's
path to the same file. A name with no file is a 404 in Chrome and a failed read in Lava:
the element's `error` either way. An `async` script runs whenever its fetch completes,
so a case pins only what holds in any order (each script's own line, sorted, and that
it ran before `load`). Module scripts do not run in Lava (no module loader in the
JavaScriptCore C API): `dom-script-module.page` is a known gap.

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

## The public-site corpus

`cases/site-*.nav*.html` are real-world-shaped pages written for the suite — a news
article, a WordPress post, a shop product page, a 1999 FrontPage page in
ISO-8859-1, a docs page, a Shift_JIS portal, an SPA shell, a phpBB thread behind a
UTF-8 BOM — not saved from live sites: no third party's markup is checked in and no
test fetches the network. They are navigation cases, so they also exercise the
charset path; scripts in them never run (the frame is sandboxed, and `lava html`
runs none). When the corpus landed, all 16 of their views matched Chrome 158.

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
| `4b`        | the rest of the Window DOM: window as an EventTarget, external scripts     |
| `unplanned` | no stage closes it (a lexbor parser divergence); needs an issue of its own |

When stage 3b landed, all 120 hand-case views and 3440 of the 3568 html5lib views
matched Chrome 158 (96.4%). The 128 listed are 126 views of fragments for an SVG or
MathML context (`3e`) and one `select`-context case where lexbor's parser drops an
`<input>` Chrome keeps (`unplanned`).
