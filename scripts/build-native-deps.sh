#!/usr/bin/env sh
set -eu

# Compile the vendored C dependencies that Odin links into the runtime. Today that is
# just picohttpparser (pkg/runtime/picohttpparser); the Odin `foreign import` there
# expects libpicohttpparser.a next to the source. Idempotent: each archive is rebuilt
# only when its source/header is newer, so it is cheap to run before every build/test
# (build.sh, run-tests.sh, and the test-odin make target all invoke it).
#
# Linux-first: uses cc (clang/gcc). The Windows build compiles its native bits in
# scripts/build-windows.ps1 instead.

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CC=${CC:-cc}
CFLAGS=${CFLAGS:--O2 -fPIC}

build_archive() {
	dir=$1
	stem=$2
	src="$dir/$stem.c"
	hdr="$dir/$stem.h"
	obj="$dir/$stem.o"
	lib="$dir/lib$stem.a"

	if [ -f "$lib" ] && [ ! "$src" -nt "$lib" ] && [ ! "$hdr" -nt "$lib" ]; then
		return 0 # up to date
	fi
	# shellcheck disable=SC2086
	"$CC" $CFLAGS -c "$src" -o "$obj"
	ar rcs "$lib" "$obj"
	printf 'built %s\n' "${lib#$ROOT_DIR/}"
}

build_archive "$ROOT_DIR/pkg/runtime/picohttpparser" picohttpparser

# lexbor + the pkg/html shim (pinned source build into .deps/; see the script).
"$ROOT_DIR/scripts/build-lexbor.sh"
