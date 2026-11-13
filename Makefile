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

.PHONY: test-stdio help bootstrap-windows-deps build-sqlite-windows build run eval check check-cli check-runtime check-js fix-js check-md fix-md check-actions check-primordials test-scripts test-property test-mutation check-jsc check-native native-deps test test-all test-lava test-lava-nohostfn test-odin-serial api-surface bun-buffer-tests test-compat test-compat-lava test-compat-lava-strict test-odin test-eventloop-odin test-runtime-odin test-sqlite-odin test-sqlite-node test-sqlite-lava test-fs-node test-fs-lava test-eventloop-node test-eventloop-lava test-fetch-smoke test-net-smoke test-http-smoke test-https-smoke test-multicore-smoke test-zerocopy-smoke bench bench-gate bench-http bench-pages fmt clean

help:
	@printf '%s\n' 'Lava commands'
	@printf '%s\n' ''
	@printf '%s\n' 'Build / run'
	@printf '%s\n' '  make build              Build the lava CLI'
	@printf '%s\n' '  make native-deps        Build vendored C deps (picohttpparser)'
	@printf '%s\n' '  make bootstrap-windows-deps Fetch ignored Windows native deps into .deps/'
	@printf '%s\n' '  make build-sqlite-windows Build build/sqlite3.lib via MSVC'
	@printf '%s\n' '  make run FILE=app.js    Run a JavaScript file through lava'
	@printf '%s\n' '  make eval SOURCE=...    Evaluate JavaScript source through lava'
	@printf '%s\n' '  make clean              Remove build artifacts'
	@printf '%s\n' ''
	@printf '%s\n' 'Check / format'
	@printf '%s\n' '  make check              Type-check Odin packages (incl. windows/darwin front-ends)'
	@printf '%s\n' '  make check-cli          Type-check cmd/lava only'
	@printf '%s\n' '  make check-runtime      Type-check runtime packages only'
	@printf '%s\n' '  make check-js           Vite+ fmt/lint + orphan-JS + scripts tests + primordials + global-replace'
	@printf '%s\n' '  make fix-js             Auto-fix JS formatting/lint'
	@printf '%s\n' '  make check-md           Markdown lint (markdownlint-cli2)'
	@printf '%s\n' '  make fix-md             Auto-fix markdown lint'
	@printf '%s\n' '  make check-actions      actionlint over .github/workflows'
	@printf '%s\n' '  make check-primordials  Prototype-pollution ratchet (UPDATE=1 to lower; RAISE=--allow-raise)'
	@printf '%s\n' '  make check-jsc          Locate JavaScriptCore dev files with install hints'
	@printf '%s\n' '  make check-native       Verify native build dependencies via pkg-config'
	@printf '%s\n' '  make fmt                Strip optional semicolons in Odin sources'
	@printf '%s\n' ''
	@printf '%s\n' 'Test'
	@printf '%s\n' '  make test               Odin unit tests + oracle suites (alias of test-all on Unix)'
	@printf '%s\n' '  make test-all           Unified scripts/run-tests.sh entry point'
	@printf '%s\n' '  make test-lava          Every supported oracle suite node-vs-Lava'
	@printf '%s\n' '  make test-lava-nohostfn Same suites with private host-call ABI forced off'
	@printf '%s\n' '  make test-odin          Odin tests for cmd/lava'
	@printf '%s\n' '  make test-odin-serial   cmd/lava Odin tests on ONE runner thread'
	@printf '%s\n' '  make test-eventloop-odin Odin event-loop unit tests (serial)'
	@printf '%s\n' '  make test-runtime-odin  Odin tests for pkg/runtime'
	@printf '%s\n' '  make test-sqlite-odin   Odin tests for pkg/std/sqlite'
	@printf '%s\n' '  make test-compat        Node-only node-compat cases (+ */ported)'
	@printf '%s\n' '  make test-compat-lava   node-compat node-vs-Lava (skips known-lava-gaps)'
	@printf '%s\n' '  make test-compat-lava-strict node-compat node-vs-Lava (no skips)'
	@printf '%s\n' '  make test-fs-node / test-fs-lava'
	@printf '%s\n' '  make test-sqlite-node / test-sqlite-lava'
	@printf '%s\n' '  make test-eventloop-node / test-eventloop-lava'
	@printf '%s\n' '  make test-stdio         node:test over tests/stdio (needs bin/lava)'
	@printf '%s\n' '  make test-property      Differential property tests (PROPERTY_RUNS=N)'
	@printf '%s\n' '  make test-scripts       node:test over scripts/ only (also inside check-js)'
	@printf '%s\n' '  make test-mutation      Mutation gate (FILTER=name substring)'
	@printf '%s\n' '  make bun-buffer-tests   Ported Buffer cases node-vs-Lava'
	@printf '%s\n' ''
	@printf '%s\n' 'Smokes (bind local ports)'
	@printf '%s\n' '  make test-fetch-smoke test-net-smoke test-http-smoke'
	@printf '%s\n' '  make test-https-smoke test-multicore-smoke test-zerocopy-smoke'
	@printf '%s\n' ''
	@printf '%s\n' 'Bench / report'
	@printf '%s\n' '  make bench              node-vs-Lava ratio table (report-only)'
	@printf '%s\n' '  make bench-gate         Fail if any ratio exceeds bench/thresholds.json'
	@printf '%s\n' '  make bench-http         HTTP throughput/latency report (not in CI)'
	@printf '%s\n' '  make bench-pages        Pages per thread: start-up, RSS, pages/s (not in CI)'
	@printf '%s\n' '  make api-surface        Buffer/Crypto surface diff vs Node (report-only)'
	@printf '%s\n' ''
	@printf '%s\n' 'Env knobs (oracle runners):'
	@printf '%s\n' '  RUN_LAVA=1              Compare each case Node-vs-Lava instead of Node-only'
	@printf '%s\n' '  SKIP_KNOWN_LAVA_GAPS=1  Skip paths listed in the matching known-lava-gaps.txt'
	@printf '%s\n' '  NODE_BIN=/path/to/node  Override the Node oracle binary'
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

check: check-cli check-runtime
	$(ODIN) check pkg/jsc -no-entry-point

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

# Compile vendored C deps (picohttpparser) Odin links into the runtime. Idempotent;
# `odin check` does not need it, but every link of cmd/lava (build, test-odin) does.
native-deps:
	$(RUNSCRIPT) ./scripts/build-native-deps.sh

check-js:
	vp run js:check

fix-js:
	vp run js:fix

# Markdown lint over the repo's own docs (config + rationale for the two disabled rules:
# .markdownlint-cli2.jsonc). Catches MD040 and friends locally instead of in review.
check-md:
	vp run md:check

fix-md:
	vp run md:fix

# actionlint (WASM build, no Go toolchain) over .github/workflows. Catches the semantic
# mistakes a YAML parse cannot: contexts used where they are not available, bad `needs`,
# shellcheck errors inside `run:` blocks.
check-actions:
	vp run actions:check

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

# MUTATION GATE. Applies each entry in tests/mutation-manifest.json to production
# source and requires the named test to go RED. CLAUDE.md §6 has always demanded
# this by hand; doing it by hand depends on remembering to, and three tests in #321
# got past exactly that — each passed, and each passed just as well with the code it
# claimed to pin deleted. Refuses to report unless the tree is clean, every `find`
# is unique, and every gate is green BEFORE mutating: "it went red" proves nothing
# about a gate that was already red.
# Rebuilds bin/lava per embedded-JS mutation, so it is minutes, not seconds — its
# own target and its own CI step, never part of the always-block.
#   make test-mutation FILTER=clone   # substring match on the entry name
#   node scripts/run-mutations.mjs --list
#   MUTATION_TIMEOUT_MS=N             # default per-gate timeout ms (default 120000); hang pins use manifest timeout_ms
test-mutation: build
	@node scripts/run-mutations.mjs $(if $(FILTER),--filter=$(FILTER),)

# Differential PROPERTY tests: fast-check generates the inputs and both runtimes
# answer, so a mismatch shrinks to a minimal reproducer instead of arriving as a
# 4 KB buffer. Every decoder defect found in #320/#321 was an edge case somebody
# picked or missed by hand; this explores the space instead. BATCHED — one node
# +lava process pair per property, not per input, which is what made 5000 inputs
# affordable (~1s) where the per-input shape cost 64s for 200 and had to stay out
# of CI. Needs bin/lava, hence its own target rather than part of the
# always-block. PROPERTY_RUNS raises the count for a deeper local run.
test-stdio: build
	LAVA_BIN="$(LAVA)" node --test 'tests/stdio/**/*.test.mjs'

test-property: build
	LAVA_BIN="$(LAVA)" node --test 'tests/property/**/*.property.test.mjs'

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

api-surface: build
	$(RUNSCRIPT) ./scripts/report-api-surface.sh

bun-buffer-tests: build
	LAVA_BIN="$(LAVA)" ./scripts/report-bun-buffer-tests.sh

test-compat:
	$(RUNSCRIPT) ./scripts/run-node-compat-all.sh

test-compat-lava: build
	RUN_LAVA=1 SKIP_KNOWN_LAVA_GAPS=1 LAVA_BIN="$(LAVA)" ./scripts/run-node-compat-all.sh

test-compat-lava-strict: build
	RUN_LAVA=1 LAVA_BIN="$(LAVA)" ./scripts/run-node-compat-all.sh

test-odin: native-deps
	$(ODIN) test cmd/lava -collection:lava=.

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

ifeq ($(OS),Windows_NT)
test-sqlite-odin:
	powershell -NoProfile -ExecutionPolicy Bypass -Command "if (!(Test-Path 'build/sqlite3.lib')) { Write-Host 'skipping pkg/std/sqlite Odin link test (missing build/sqlite3.lib; run Windows bootstrap/MSVC build first)'; exit 0 }; $$env:LIB = (Resolve-Path 'build').Path + ';' + $$env:LIB; & '$(ODIN)' test pkg/std/sqlite; exit $$LASTEXITCODE"
else
test-sqlite-odin:
	$(ODIN) test pkg/std/sqlite
endif

test-sqlite-node:
	$(RUNSCRIPT) ./scripts/run-sqlite-oracle.sh

test-sqlite-lava: build
	RUN_LAVA=1 LAVA_BIN="$(LAVA)" ./scripts/run-sqlite-oracle.sh

test-fs-node:
	$(RUNSCRIPT) ./scripts/run-fs-oracle.sh

test-fs-lava: build
	RUN_LAVA=1 LAVA_BIN="$(LAVA)" ./scripts/run-fs-oracle.sh

test-eventloop-node:
	$(RUNSCRIPT) ./scripts/run-eventloop-oracle.sh

test-eventloop-lava: build
	RUN_LAVA=1 SKIP_KNOWN_LAVA_GAPS=1 LAVA_BIN="$(LAVA)" ./scripts/run-eventloop-oracle.sh

test-fetch-smoke: build
	LAVA_BIN="$(LAVA)" ./scripts/run-fetch-smoke.sh

test-net-smoke: build
	LAVA_BIN="$(LAVA)" ./scripts/run-net-smoke.sh
	LAVA_BIN="$(LAVA)" LAVA_NET_FORCE_READINESS=1 ./scripts/run-net-smoke.sh

test-http-smoke: build
	LAVA_BIN="$(LAVA)" ./scripts/run-http-smoke.sh
	LAVA_BIN="$(LAVA)" LAVA_NET_FORCE_READINESS=1 ./scripts/run-http-smoke.sh

# The https smoke drives BOTH backends itself (proactor + readiness inside the script), so it is a
# single invocation unlike the http/zerocopy smokes.
test-https-smoke: build
	LAVA_BIN="$(LAVA)" ./scripts/run-https-smoke.sh

test-multicore-smoke: build
	LAVA_BIN="$(LAVA)" ./scripts/run-multicore-smoke.sh

test-zerocopy-smoke: build
	LAVA_BIN="$(LAVA)" ./scripts/run-zerocopy-smoke.sh
	LAVA_BIN="$(LAVA)" LAVA_NET_FORCE_READINESS=1 ./scripts/run-zerocopy-smoke.sh

# bench runs the micro/macro benchmarks node-vs-Lava and prints a ratio table; it never
# fails on timing (report-only). bench-gate adds --gate, enforcing the per-benchmark
# lava/node ratio caps in bench/thresholds.json (exit non-zero on a regression).
bench: build
	LAVA_BIN="$(LAVA)" ./scripts/run-bench.sh

bench-gate: build
	LAVA_BIN="$(LAVA)" ./scripts/run-bench.sh --gate

# HTTP server benchmark: hello-world throughput (req/s, latency) and memory-per-idle-
# connection for Lava vs Node vs Bun. Report-only; binds local ports.
bench-http: build
	LAVA_BIN="$(LAVA)" $${NODE_BIN:-node} bench/http/run-http-bench.mjs

# Pages per thread (#4): N = 1/10/50/100 concurrent pages on one thread's page runner —
# cold vs warm VM start-up, RSS per live page and per idle pooled VM, pages/s. Medians
# of LAUNCHES (default 5) processes per N. Report-only; needs native-deps, not lava.
bench-pages: native-deps
	./bench/pages/run.sh

# test-lava runs every oracle suite the platform supports through one entry point
# (scripts/run-oracles.sh) — the same script the Windows CI job runs against
# lava.exe. The per-suite test-*-lava targets above remain for granular runs.
test-lava: build
	RUN_LAVA=1 LAVA_BIN="$(LAVA)" ./scripts/run-oracles.sh

# Same suites with the private-ABI host-call path forced off, so every native is
# built by JSObjectMakeFunctionWithCallback instead. That fallback is documented
# behaviour with no coverage: it was only ever exercised by the macOS and Windows
# jobs, which have been disabled since the Linux-first switch, and it is exactly
# where a JSC upgrade that renamed the mangled symbol pkg/jsc dlsyms would land the
# whole runtime. Same idea as test-net-smoke running both socket backends.
test-lava-nohostfn: build
	RUN_LAVA=1 LAVA_BIN="$(LAVA)" LAVA_HOSTFN_DISABLE=1 ./scripts/run-oracles.sh

# -collection:lava=. is required, not optional: cmd/lava's test files import
# "lava:pkg/runtime", so without it strip-semicolon cannot parse the package and
# the target exits non-zero. CI's "Format (Odin)" step runs this and requires a
# clean diff afterwards.
fmt:
	$(ODIN) strip-semicolon cmd/lava -collection:lava=.
	$(ODIN) strip-semicolon pkg/jsc -no-entry-point

# `rm` isn't a Windows command and can't take the $(RUNSCRIPT) prefix (bash would treat
# `rm` as a script), so invoke the shell explicitly: $(SHELL) is Git Bash on Windows and
# /bin/sh on Unix, and the quotes force make to route through it instead of direct-exec.
clean:
	"$(SHELL)" -c "rm -rf bin build pkg/runtime/picohttpparser/*.a pkg/runtime/picohttpparser/*.o"

