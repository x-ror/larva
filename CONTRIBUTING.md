# Contributing to Larva

## Licence of contributions

Larva is dual-licensed: the code in this repository is published under
[AGPL-3.0-only](LICENSE), and the same code is also offered under a commercial
licence (see [README.md](README.md#license)). Offering both requires the project
to hold the right to license every line under either set of terms.

For that reason a contribution from outside the project is merged only after its
author has signed a Contributor License Agreement that grants the project that
right. The author keeps the copyright in their work.

**The agreement text is not published yet.** Until it is, pull requests from
outside contributors can be reviewed and discussed but not merged. Issues, bug
reports and reproductions need no agreement and are welcome now.

Do not submit code you did not write unless its licence allows both uses above.
Permissive licences (MIT, BSD, Apache-2.0, ISC) qualify; GPL-only and AGPL-only
code does not. Say where the code came from in the pull request, and add it to
[NOTICE](NOTICE).

## How work is judged

The working agreement is [CLAUDE.md](CLAUDE.md): oracle conformance first, then
speed and memory, with tests, docs and security as gates. Read
[docs/LARVA.md](docs/LARVA.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
before a structural change.

Before opening a pull request:

```sh
make check      # Odin type-check, including the cross-target front-end
make check-js   # formatter, linter and the primordials ratchet
make check-md   # markdownlint
make test       # Odin unit tests and the oracle suites
```

Pull request titles follow `type(scope): imperative summary`, and the body states
what changed, which gates were run with their results, and the oracle evidence
for any change to an observable surface.
