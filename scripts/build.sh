#!/usr/bin/env sh
set -eu

# Compile vendored C deps (picohttpparser) that Odin links into the runtime. Idempotent.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"
mkdir -p bin
"$ROOT_DIR/scripts/build-native-deps.sh"

# Optimized release build by default (-o:speed). Override for a fast debug/iteration
# build, e.g. `LAVA_OPT=none ./scripts/build.sh`. Levels: none|minimal|size|speed|aggressive.
OPT="${LAVA_OPT:-speed}"
# LAVA_JS_OVERRIDE=1 builds the dev-only binary that can load pkg/runtime/js from disk
# (pkg/runtime/globals.odin, js_override_dir). Only the mutation runner sets it; a
# normal build never contains that code path.
JS_OVERRIDE="${LAVA_JS_OVERRIDE:-0}"
DEFINES=""
[ "$JS_OVERRIDE" = "1" ] && DEFINES="-define:LAVA_JS_OVERRIDE=true"
BIN_PATH="$ROOT_DIR/bin/lava"
NATIVE_STAMP_FILE="$ROOT_DIR/bin/.lava.native.stamp"
JS_STAMP_FILE="$ROOT_DIR/bin/.lava.js.stamp"
JS_OVERRIDE_FILE="$ROOT_DIR/bin/.lava.js-override"

compute_native_stamp() {
	{
		printf 'OPT=%s DEFINES=%s\n' "$OPT" "$DEFINES"
		# A new Odin toolchain recompiles core: — the sources below would not show it.
		odin version 2>/dev/null || true
		cksum "$ROOT_DIR/scripts/build.sh" "$ROOT_DIR/scripts/build-native-deps.sh"
		if [ -f "$ROOT_DIR/pkg/runtime/picohttpparser/libpicohttpparser.a" ]; then
			cksum "$ROOT_DIR/pkg/runtime/picohttpparser/libpicohttpparser.a"
		fi
		find "$ROOT_DIR/cmd" "$ROOT_DIR/pkg" \( -name '*.odin' -o -name '*.c' -o -name '*.h' \) -print |
			LC_ALL=C sort |
			xargs cksum
	} | cksum
}

compute_js_stamp() {
	find "$ROOT_DIR/pkg/runtime/js" -name '*.js' -print |
		LC_ALL=C sort |
		xargs cksum |
		cksum
}

cur_native=$(compute_native_stamp)
cur_js=$(compute_js_stamp)

if [ "${LAVA_FORCE_BUILD:-0}" != "1" ] &&
	[ -x "$BIN_PATH" ] &&
	[ -f "$NATIVE_STAMP_FILE" ] &&
	[ -f "$JS_STAMP_FILE" ]; then
	old_native=$(cat "$NATIVE_STAMP_FILE")
	old_js=$(cat "$JS_STAMP_FILE")
	if [ "$cur_native" = "$old_native" ]; then
		if [ "$cur_js" = "$old_js" ]; then
			rm -f "$JS_OVERRIDE_FILE"
			exit 0
		elif [ "$JS_OVERRIDE" = "1" ]; then
			# Only embedded runtime JS changed since this override build was linked: let
			# pkg/runtime/globals.odin load js/** from disk instead of relinking bin/lava
			# for every JS mutation. A normal build never takes this branch — it relinks,
			# so the JS it ships is always the JS it embeds.
			printf '1\n' >"$JS_OVERRIDE_FILE"
			exit 0
		fi
	fi
fi

# No extra linker flags are needed: Linux links system libssl/libcrypto from the
# default path, and macOS needs no OpenSSL linker flags for fetch TLS (#143).
# (Windows builds via scripts/build-windows.ps1.)
# shellcheck disable=SC2086 # DEFINES is empty or one flag
odin build cmd/lava -collection:lava=. -out:bin/lava -o:"$OPT" $DEFINES
printf '%s\n' "$cur_native" >"$NATIVE_STAMP_FILE"
printf '%s\n' "$cur_js" >"$JS_STAMP_FILE"
rm -f "$JS_OVERRIDE_FILE"
