ODIN ?= odin
ifeq ($(OS),Windows_NT)
# Native Windows GNU Make defaults to cmd.exe, but every recipe here is POSIX shell
# (inline VAR=val env, bare ./scripts/*.sh, rm -rf, printf …). Run them through Git Bash
# so the same recipes work as on Linux/macOS; otherwise `make bench`/`clean`/test-*-lava
# fail under cmd.exe with errors like "'LAVA_BIN' is not recognized".
#
# Point at Git Bash by its full path on purpose: a bare `bash` on the Windows PATH is
# typically WSL's bash.exe (under WindowsApps), which runs in a Linux VM that cannot see
# the Windows build tree. Override if Git for Windows lives elsewhere, e.g.
#   make bench GIT_BASH="D:/Git/bin/bash.exe"
GIT_BASH ?= C:/Program Files/Git/bin/bash.exe
SHELL := $(GIT_BASH)
# SHELL alone isn't enough on Windows: make "direct-executes" simple single-command
# recipes (a bare ./scripts/x.sh, rm -rf …) without the shell, so they run via the
# script's shebang and die ("env" isn't on the Windows PATH). Prefix those recipes with
# $(RUNSCRIPT) to force them through Git Bash. (Empty on Unix — the default shell already
# runs them and respects each script's own shebang.)
RUNSCRIPT := "$(GIT_BASH)"
LAVA ?= build/lava.exe
else
RUNSCRIPT :=
LAVA ?= bin/lava
endif
SOURCE ?= console.log('hello from Lava')
FILE ?=

.PHONY: gates test-stdio test-web record-web test-dom record-dom help env sdk-diff test-one bootstrap-windows-deps build-sqlite-windows build run eval check check-cli check-runtime check-js fix-js check-md fix-md check-actions check-primordials test-scripts test-mutation check-jsc check-native native-deps test test-all test-odin-serial test-odin test-eventloop-odin test-runtime-odin test-html-odin test-http-odin test-sqlite-odin test-odin-green bench bench-gate fmt clean test-fetch-html-smoke test-serve test-bench-pages-smoke bench-pages bench-html

help:
	@printf '%s\n' 'Lava commands'
	@printf '%s\n' ''
	@printf '%s\n' 'Toolchain'
	@printf '%s\n' '  make env                Pinned Odin vs the local compiler/SDK, C libs, node, cores'
	@printf '%s\n' '  make sdk-diff [TO=rev]  What an Odin revision adds/changes vs .odin-version (default TO=HEAD of the SDK checkout)'
	@printf '%s\n' ''
	@printf '%s\n' 'Build / run'
	@printf '%s\n' '  make build              Build the lava CLI'
	@printf '%s\n' '  make native-deps        Build vendored C deps (picohttpparser, lexbor)'
	@printf '%s\n' '  make bootstrap-windows-deps Fetch ignored Windows native deps into .deps/'
	@printf '%s\n' '  make build-sqlite-windows Build build/sqlite3.lib via MSVC'
	@printf '%s\n' '  make run FILE=page.js   Run a classic script with the Window globals'
	@printf '%s\n' '  make eval SOURCE=...    Evaluate a classic script with the Window globals'
	@printf '%s\n' '  make clean              Remove build artifacts'
	@printf '%s\n' ''
	@printf '%s\n' 'Check / format'
	@printf '%s\n' '  make check              Type-check Odin packages (incl. windows/darwin front-ends)'
	@printf '%s\n' '  make check-cli          Type-check cmd/lava only'
	@printf '%s\n' '  make check-runtime      Type-check runtime packages only'
	@printf '%s\n' '  make check-js           Vite+ fmt/lint + JS module graph + scripts tests + primordials + global-replace'
	@printf '%s\n' '  make fix-js             Auto-fix JS formatting/lint'
	@printf '%s\n' '  make check-md           Markdown fmt + lint'
	@printf '%s\n' '  make fix-md             Auto-fix markdown lint'
	@printf '%s\n' '  make check-actions      actionlint over .github/workflows'
	@printf '%s\n' '  make check-primordials  Prototype-pollution ratchet (UPDATE=1 to lower; RAISE=--allow-raise)'
	@printf '%s\n' '  make check-jsc          Locate JavaScriptCore dev files with install hints'
	@printf '%s\n' '  make check-native       Verify native build dependencies via pkg-config'
	@printf '%s\n' '  make fmt                Format Odin (odinfmt, strip-semicolon) and C/C++ (clang-format)'
	@printf '%s\n' ''
	@printf '%s\n' 'Test'
	@printf '%s\n' '  make test               Odin unit tests (alias of test-all on Unix)'
	@printf '%s\n' '  make test-all           Unified scripts/run-tests.sh entry point'
	@printf '%s\n' '  make test-odin          Odin tests for cmd/lava'
	@printf '%s\n' '  make test-one T=a,b     Only the named Odin tests (PKG=pkg/runtime for another package)'
	@printf '%s\n' '  make test-odin-serial   cmd/lava Odin tests on ONE runner thread'
	@printf '%s\n' '  make test-odin-green    cmd/lava Odin tests as CI runs them (SERIAL=1: one thread)'
	@printf '%s\n' '  make test-eventloop-odin Odin event-loop unit tests (serial)'
	@printf '%s\n' '  make test-runtime-odin  Odin tests for pkg/runtime'
	@printf '%s\n' '  make test-html-odin     Odin tests for pkg/html (lexbor + shim)'
	@printf '%s\n' '  make test-http-odin     Odin tests for pkg/http and its cookie jar (against recorded Chrome)'
	@printf '%s\n' '  make test-sqlite-odin   Odin tests for pkg/std/sqlite'
	@printf '%s\n' '  make test-stdio         node:test over tests/stdio (needs bin/lava)'
	@printf '%s\n' '  make test-web           Window-profile cases vs their Chrome recordings (tests/web)'
	@printf '%s\n' '  make record-web [CASES=a b]  Re-record tests/web cases in headless Chrome'
	@printf '%s\n' '  make test-dom           lava html tree/serialization vs Chrome recordings (tests/dom)'
	@printf '%s\n' '  make record-dom [CASES=a b]  Re-record tests/dom cases in headless Chrome'
	@printf '%s\n' '  make test-scripts       node:test over scripts/ only (also inside check-js)'
	@printf '%s\n' '  make test-mutation      Mutation gate (CHANGED=1: only what the diff affects; FILTER=name)'
	@printf '%s\n' '  make gates              Run routed gates for the current diff (stops on first failure)'
	@printf '%s\n' ''
	@printf '%s\n' 'Smokes (bind local ports)'
	@printf '%s\n' '  make test-fetch-html-smoke  lava fetch (redirect, coding, charset) vs tests/dom recordings'
	@printf '%s\n' '  make test-serve         lava serve: its Odin tests over loopback, then the SIGTERM smoke'
	@printf '%s\n' '  make test-bench-pages-smoke  bench/pages builds, runs, and fails on a refused page'
	@printf '%s\n' ''
	@printf '%s\n' 'Bench / report'
	@printf '%s\n' '  make bench              Lava new-vs-base ns/op table, BASE=<bin> (report-only)'
	@printf '%s\n' '  make bench-gate         Fail if a new/base ratio exceeds bench/thresholds.json'
	@printf '%s\n' '  make bench-pages        Pages per thread: start-up, RSS, pages/s (not in CI)'
	@printf '%s\n' '  make bench-html         HTML serializer, pkg/html vs lexbor, ns per KB (not in CI)'
	@printf '%s\n' ''
	@printf '%s\n' 'Env knobs:'
	@printf '%s\n' '  LAVA_BIN=/path/to/lava  Override the Lava binary under test'

bootstrap-windows-deps:
	$(RUNSCRIPT) ./scripts/bootstrap-windows-deps.sh

ifeq ($(OS),Windows_NT)
build-sqlite-windows:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-sqlite-windows.ps1
else
build-sqlite-windows:
	bash ./scripts/build-sqlite-windows.sh
endif

ifeq ($(OS),Windows_NT)
build:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1
else
build:
	./scripts/build.sh
endif

run: build
	@test -n "$(FILE)" || { printf '%s\n' 'usage: make run FILE=app.js'; exit 2; }
	$(LAVA) run "$(FILE)"

eval: build
	$(LAVA) eval "$(SOURCE)"

# The toolchain report agents read first (CLAUDE.md §3). Never
# fails: `node scripts/odin-env.mjs --check` is the strict form CI runs.
env:
	@ODIN=$(ODIN) node scripts/odin-env.mjs

# SDK additions and breaking changes between the pin and TO, read for Larva
# (CLAUDE.md §2). Needs the SDK as a git checkout; ODIN_ROOT selects another one.
TO ?= HEAD
sdk-diff:
	@ODIN=$(ODIN) node scripts/sdk-diff.mjs --to $(TO)

check: check-cli check-runtime
	$(ODIN) check pkg/jsc -no-entry-point
	# bench/pages is report-only and nothing else compiles it; without this a runtime
	# API change breaks it silently (#26 did, by making the CPU budget mandatory).
	$(ODIN) check bench/pages -collection:lava=.
	$(ODIN) check bench/html -collection:lava=.

check-cli:
	$(ODIN) check cmd/lava -collection:lava=.

check-runtime:
	$(ODIN) check pkg/runtime -no-entry-point -collection:lava=.
	$(ODIN) check pkg/runtime/eventloop -no-entry-point
	$(ODIN) check pkg/runtime/picohttpparser -no-entry-point
	$(ODIN) check pkg/std/sqlite -no-entry-point
	# Cross-platform front-end check (no link): catches a compile/symbol regression in the
	# non-Linux stubs (net_other.odin) and the linux,windows TLS bindings before they reach a
	# Windows/macOS build. `odin check` doesn't link, so it can't fully prove symbol elision.
	$(ODIN) check pkg/runtime -no-entry-point -collection:lava=. -target:windows_amd64
	$(ODIN) check pkg/runtime -no-entry-point -collection:lava=. -target:darwin_arm64
	# pkg/http is not reached from pkg/runtime, so its !linux stubs (transfer_other.odin,
	# content_coding_other.odin) get their own front-end check on every target.
	$(ODIN) check pkg/http -no-entry-point -collection:lava=.
	$(ODIN) check pkg/http -no-entry-point -collection:lava=. -target:windows_amd64
	$(ODIN) check pkg/http -no-entry-point -collection:lava=. -target:darwin_arm64
	# pkg/html's !linux stubs (lexbor_other.odin) and the layout mirror, which every
	# target compiles, the same way.
	$(ODIN) check pkg/html -no-entry-point -collection:lava=.
	$(ODIN) check pkg/html -no-entry-point -collection:lava=. -target:windows_amd64
	$(ODIN) check pkg/html -no-entry-point -collection:lava=. -target:darwin_arm64
	# pkg/adapters (`lava serve`): its !linux stub (serve_other.odin) refuses with a real
	# error; cmd/lava reaches only the Linux side.
	$(ODIN) check pkg/adapters -no-entry-point -collection:lava=.
	$(ODIN) check pkg/adapters -no-entry-point -collection:lava=. -target:windows_amd64
	$(ODIN) check pkg/adapters -no-entry-point -collection:lava=. -target:darwin_arm64

# Compile vendored C deps (picohttpparser) Odin links into the runtime. Idempotent;
# `odin check` does not need it, but every link of cmd/lava (build, test-odin) does.
native-deps:
	$(RUNSCRIPT) ./scripts/build-native-deps.sh

check-js:
	bun run js:check

fix-js:
	bun run js:fix

# Markdown format (bun fmt, bunfig.toml) + lint over the repo's own docs (lint config + rationale for the two disabled rules:
# .markdownlint-cli2.jsonc). Catches MD040 and friends locally instead of in review.
check-md:
	bun run md:check

fix-md:
	bun run md:fix

# actionlint (WASM build, no Go toolchain) over .github/workflows. Catches the semantic
# mistakes a YAML parse cannot: contexts used where they are not available, bad `needs`,
# shellcheck errors inside `run:` blocks.
check-actions:
	bun run actions:check

# Prototype-pollution ratchet over the embedded runtime JS (also part of check-js).
# UPDATE=1 LOWERS the baseline after hardening a module; a RAISE is refused
# unless RAISE=--allow-raise is passed too (a newly scanned file, or a new class).
check-primordials:
	@if [ "$(UPDATE)" = "1" ]; then node scripts/check-primordials.mjs --update $(RAISE); \
	else node scripts/check-primordials.mjs; fi

# node:test over the build-tooling scripts. The pollution ratchet's fixtures gate
# the ratchet itself (it refuses to report or rebaseline when one regresses); this
# target runs the same table with named subtests, a real diff, and
# --test-name-pattern for iterating on one case. Part of `make check-js`.
test-scripts:
	node --test 'scripts/**/*.test.mjs'

# Honest gate runner (#360): routes the current diff through runtime/gates/route-gates.mjs,
# runs each gate without piping into tail, stops on the first failure, and prints a
# summary table with real exit codes. Pass PATHS="file1 file2" or ARGS="--all" to override.
gates:
	node scripts/run-gates.mjs $(ARGS) $(PATHS)

# MUTATION GATE. Applies each entry in tests/mutation-manifest.json to production
# source and requires the named test to go RED. CLAUDE.md §6 has always demanded
# this by hand; doing it by hand depends on remembering to, and three tests in #321
# got past exactly that — each passed, and each passed just as well with the code it
# claimed to pin deleted. Refuses to report unless the tree is clean, every `find`
# is unique, and every gate is green BEFORE mutating: "it went red" proves nothing
# about a gate that was already red.
# Rebuilds bin/lava per embedded-JS mutation, so it is minutes, not seconds — its
# own target and its own CI step, never part of the always-block. Mutant builds
# run at -o:none (MUTATION_OPT) and the final restore build at the normal level;
# the runner prints where the time went, by gate kind.
#   make test-mutation FILTER=clone   # substring match on the entry name
#   make test-mutation CHANGED=1      # only entries the diff vs origin/master can affect
#   MUTATION_OPT=speed                # mutant builds default to -o:none; this restores the old cost
#   node scripts/run-mutations.mjs --list
#   MUTATION_TIMEOUT_MS=N             # default per-gate timeout ms (default 120000); hang pins use manifest timeout_ms
#   make test-mutation SHARD=2/3      # one of N disjoint slices (CI runs three side by side)
test-mutation: build
	@node scripts/run-mutations.mjs $(if $(FILTER),'--filter=$(FILTER)',) $(if $(CHANGED),--changed,) $(if $(SHARD),--shard=$(SHARD),)

test-stdio: build
	LAVA_BIN="$(LAVA)" node --test 'tests/stdio/**/*.test.mjs'

# The Window-profile oracle (tests/web, x-ror/larva#2): every case runs under
# `lava run` and its stdout must equal the output recorded from Chrome
# byte for byte; tests/web/known-gaps.txt lists, with a stage and a reason, the cases
# Lava does not match yet, each held to its pinned output. Needs bin/lava, not Chrome:
# the recordings are committed. record-web re-records them (needs google-chrome;
# CHROME_BIN overrides), CASES= for a subset.
test-web: build
	LAVA_BIN="$(LAVA)" node scripts/run-web-oracle.mjs

record-web:
	node scripts/record-chrome.mjs $(CASES)

# The DOM oracle (tests/dom, stage 3a of docs/LARVA.md): every HTML case is parsed by
# `lava html` and two views of the result — the html5lib-format tree (--tree) and the
# serialization — must equal what headless Chrome recorded byte for byte; a gap is
# listed per view in tests/dom/known-gaps.txt with a stage and held to its pin. Needs
# bin/lava, not Chrome. record-dom re-records (needs google-chrome), CASES= for a subset.
test-dom: build
	LAVA_BIN="$(LAVA)" node scripts/run-dom-oracle.mjs

record-dom:
	node scripts/record-dom.mjs $(CASES)

check-jsc:
	$(RUNSCRIPT) ./scripts/check-jsc.sh

check-native:
	$(RUNSCRIPT) ./scripts/check-native-deps.sh

ifeq ($(OS),Windows_NT)
test: test-odin test-eventloop-odin test-sqlite-odin
else
test: test-all
endif

test-all:
	$(RUNSCRIPT) ./scripts/run-tests.sh

test-odin: native-deps
	$(ODIN) test cmd/lava -collection:lava=.

# Only the named tests: `make test-one T=a,b` (PKG=pkg/runtime for another package).
# ODIN_TEST_NAMES wants package-qualified names, and the package clause is not the
# directory name (cmd/lava is `main`), so it is read from the sources.
PKG ?= cmd/lava
test-one: native-deps
	@test -n "$(T)" || { echo 'make test-one: set T=<test>[,<test>...]' >&2; exit 2; }
	@ns=$$(sed -n 's/^package \([A-Za-z_0-9]*\).*/\1/p' $(PKG)/*.odin | head -1); \
	names=$$(printf '%s' '$(T)' | sed "s/[^,][^,]*/$$ns.&/g"); \
	echo "$(ODIN) test $(PKG) -collection:lava=. -define:ODIN_TEST_NAMES=$$names"; \
	$(ODIN) test $(PKG) -collection:lava=. -define:ODIN_TEST_NAMES=$$names

# The Odin test runner defaults to one thread per core, so each test that calls
# lava.eval usually gets a fresh thread — and the host-native registry, the
# private-ABI probe latch and JSC's context-address recycling are all THREAD-local.
# One runner thread is the only configuration where several eval call sites share
# a thread, which is the exact shape of the two defects fixed in #317 (a
# thread-lived table bound to a per-test tracking allocator; a cache keyed by a
# recycled JSGlobalContext address). Cheap enough to just run: ~0.25s.
#
# -define:, NOT an environment variable. core/testing/runner.odin:34 declares
# `TEST_THREADS :: #config(ODIN_TEST_THREADS, 0)`, and #config is resolved at
# COMPILE time — an env var of the same name is silently ignored, the binary
# keeps the 0 default ("one thread per core"), and the target exits 0 having
# tested nothing. It shipped that way and was green on 16 threads; the runner's
# own banner ("Set with -define:ODIN_TEST_THREADS=n") is the tell.
test-odin-serial: native-deps
	$(ODIN) test cmd/lava -collection:lava=. -define:ODIN_TEST_THREADS=1

# cmd/lava's tests as CI's test job runs them. SERIAL=1 runs them on one runner thread,
# as test-odin-serial does, and for the same reason.
test-odin-green: native-deps
	$(ODIN) test cmd/lava -collection:lava=. $(if $(SERIAL),-define:ODIN_TEST_THREADS=1,)

# ONE runner thread: the loop owns process-wide resources (descriptors, and the
# rlimit that failed_platform_init_does_not_double_close has to tighten to reach
# the EMFILE path), so tests here cannot run beside each other without turning
# another test's fd allocation into a spurious failure. The suite is ~55ms; the
# serial cost is not measurable. Note this must be -define, NOT an environment
# variable — core/testing reads it via #config at compile time.
test-eventloop-odin:
	$(ODIN) test pkg/runtime/eventloop -define:ODIN_TEST_THREADS=1

test-runtime-odin:
	$(ODIN) test pkg/runtime -collection:lava=.

# native-deps first: the tests link the C shim, and build-lexbor.sh rebuilds it when
# pkg/html/shim/larva_html.c is newer than the archive. Linux only, as the package is.
test-html-odin: native-deps
	$(ODIN) test pkg/html

# Links system zlib, brotlidec and zstd; the expectations are recorded Chrome output
# (pkg/http/testdata/content-coding). Linux only, as the transport is, and run by `make
# test` through scripts/run-tests.sh with the same flags. A leak fails the
# run: core/testing only reports one unless FAIL_ON_BAD_MEMORY is set (a #config, so
# -define, not an environment variable), and a decode step that keeps its input buffer
# survived the leak report alone.
test-http-odin:
	$(ODIN) test pkg/http -collection:lava=. -define:ODIN_TEST_FAIL_ON_BAD_MEMORY=true
	$(ODIN) test pkg/http/cookie -collection:lava=. -define:ODIN_TEST_FAIL_ON_BAD_MEMORY=true
	$(ODIN) test pkg/http/proxy -collection:lava=. -define:ODIN_TEST_FAIL_ON_BAD_MEMORY=true

ifeq ($(OS),Windows_NT)
test-sqlite-odin:
	powershell -NoProfile -ExecutionPolicy Bypass -Command "if (!(Test-Path 'build/sqlite3.lib')) { Write-Host 'skipping pkg/std/sqlite Odin link test (missing build/sqlite3.lib; run Windows bootstrap/MSVC build first)'; exit 0 }; $$env:LIB = (Resolve-Path 'build').Path + ';' + $$env:LIB; & '$(ODIN)' test pkg/std/sqlite; exit $$LASTEXITCODE"
else
test-sqlite-odin:
	$(ODIN) test pkg/std/sqlite
endif

# `lava fetch` end to end (DOM stage 3c): tests/dom navigation cases served behind a
# redirect, compressed, with their Content-Type; stdout must equal each case's Chrome
# `#serialize` view. Binds a 127.0.0.1 port, so not in `make test`; needs no Chrome.
test-fetch-html-smoke: build
	LAVA_BIN="$(LAVA)" node scripts/run-fetch-html-smoke.mjs

# `lava serve` (#15): cmd/lava's serve_* tests — the server driven over loopback against a
# fixture origin, CPU kills, timeouts, concurrency, allocator pairing and, on one runner
# thread (SERIAL=1), the descriptor census — then scripts/run-serve-smoke.mjs, the CLI
# stopped by SIGTERM/SIGINT with a request in flight. Binds 127.0.0.1 ports.
test-serve: build
	@names=$$(sed -n 's/^\(serve_[a-z_]*\) :: proc.*/main.\1/p' cmd/lava/serve_test.odin | paste -sd, -); \
	echo "$(ODIN) test cmd/lava -collection:lava=. -define:ODIN_TEST_NAMES=$$names"; \
	$(ODIN) test cmd/lava -collection:lava=. -define:ODIN_TEST_NAMES=$$names $(if $(SERIAL),-define:ODIN_TEST_THREADS=1,)
	LAVA_BIN="$(LAVA)" node scripts/run-serve-smoke.mjs

# bench/pages, small: a valid run must report no failed page and a budget-0 run must
# exit 1 with every page counted failed. Links the runtime, so native-deps, not lava.
test-bench-pages-smoke: native-deps
	ODIN="$(ODIN)" ./scripts/run-bench-pages-smoke.sh

# bench runs bench/micro under `lava run` (Window globals) on a BASELINE binary and on
# bin/lava, interleaved, and prints ns/op for both and the new/base ratio; it never fails
# on timing (report-only). BASE=<path> picks the baseline (BASE=none: absolute numbers
# only); unset, BASE_REF (default origin/master) is built once in a temporary worktree
# and cached under bin/bench-base/. bench-gate adds --gate, enforcing the new/base caps
# in bench/thresholds.json. Local only: CI does not run either (ci.yml).
bench: build
	LAVA_BIN="$(LAVA)" BASE="$(BASE)" BASE_REF="$(BASE_REF)" ./scripts/run-bench.sh

bench-gate: build
	LAVA_BIN="$(LAVA)" BASE="$(BASE)" BASE_REF="$(BASE_REF)" ./scripts/run-bench.sh --gate

# Pages per thread (#4): N = 1/10/50/100 concurrent pages on one thread's page runner —
# cold vs warm VM start-up, process RSS growth per live page and per VM, pages/s. Medians
# of LAUNCHES (default 5) processes per N. Report-only; needs native-deps, not lava.
bench-pages: native-deps
	./bench/pages/run.sh

# The HTML serializer (stage 3b): pkg/html's against lexbor's on a 1.2 MB page and on the
# tests/dom documents, ns per KB, medians of LAUNCHES (default 7) launches that each
# alternate the two. Report-only; needs native-deps, not lava.
bench-html: native-deps
	./bench/html/run.sh

# -collection:lava=. is required, not optional: cmd/lava's test files import
# "lava:pkg/runtime", so without it strip-semicolon cannot parse the package and
# the target exits non-zero. CI's "Format (Odin)" step runs this and requires a
# clean diff afterwards.
ODINFMT ?= odinfmt

# Odin: odinfmt with odinfmt.json (tabs, 120 columns, sorted imports), then
# strip-semicolon. odinfmt ships with the OLS editor extension and is not on PATH by
# default; point ODINFMT at it. C/C++: clang-format with .clang-format; vendored
# picohttpparser opts out (its own .clang-format).
fmt:
	@if command -v $(ODINFMT) >/dev/null 2>&1; then \
		for d in cmd/lava pkg/jsc pkg/runtime pkg/std/sqlite pkg/html pkg/http pkg/tls pkg/profile pkg/adapters; do $(ODINFMT) -w $$d >/dev/null; done; \
	else echo 'make fmt: odinfmt not found; set ODINFMT=/path/to/odinfmt'; fi
	$(ODIN) strip-semicolon cmd/lava -collection:lava=.
	$(ODIN) strip-semicolon pkg/jsc -no-entry-point
	clang-format -i pkg/jsc/*.cpp pkg/html/shim/*.c
	# Multi-line blocks after if/else/for and blank lines around if: no formatter does
	# either (scripts/fmt-if.mjs). Run after odinfmt, whose convert_do makes the braces.
	node scripts/fmt-if.mjs cmd/lava pkg/jsc pkg/runtime pkg/std/sqlite pkg/html pkg/http pkg/tls pkg/profile pkg/adapters

# `rm` isn't a Windows command and can't take the $(RUNSCRIPT) prefix (bash would treat
# `rm` as a script), so invoke the shell explicitly: $(SHELL) is Git Bash on Windows and
# /bin/sh on Unix, and the quotes force make to route through it instead of direct-exec.
clean:
	"$(SHELL)" -c "rm -rf bin build pkg/runtime/picohttpparser/*.a pkg/runtime/picohttpparser/*.o"

