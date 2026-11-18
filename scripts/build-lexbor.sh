#!/usr/bin/env sh
set -eu

# Builds lexbor (https://github.com/lexbor/lexbor, Apache-2.0) as a static library for
# pkg/html, and the small C shim next to it (pkg/html/shim). Pinned to one commit,
# fetched with git and checked by its commit id, so a build never picks up an
# unreviewed lexbor. Idempotent: does nothing when the archive for this pin exists.
#
# Why git and not a release or archive tarball: GitHub does not promise that
# /archive/<sha>.tar.gz stays byte-identical, so a sha256 pin on it can break the
# build with no change upstream. A commit id is a hash of the tree itself; fetching
# it either yields exactly that tree or fails.
#
# Why a source build and not the distro package: liblexbor-dev is not installed on the
# dev machines or the CI image, and a pinned static archive keeps the parser identical
# everywhere. Why not vendored into the tree: lexbor's source is ~22 MB.
#
# Output (both under the gitignored .deps/):
#   .deps/lexbor/lib/liblexbor_static.a
#   .deps/lexbor/include/lexbor/...        (headers, for the shim)
#   .deps/lexbor/lib/liblarva_html_shim.a

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LEXBOR_REPO=https://github.com/lexbor/lexbor.git
LEXBOR_COMMIT=e609d9446f7adf06c67b89dcdc4a7c39430f0bd8
CC=${CC:-cc}

OUT="$ROOT_DIR/.deps/lexbor"
STAMP="$OUT/.commit"
LIB="$OUT/lib/liblexbor_static.a"
SHIM_SRC="$ROOT_DIR/pkg/html/shim/larva_html.c"
SHIM_LIB="$OUT/lib/liblarva_html_shim.a"

# One build at a time: make, an editor's language server and a second terminal can
# all start this script at once, and the losers would delete the winner's half-built
# tree. flock(1) is util-linux, present on every Linux this builds on; the lock is
# released when the script exits, however it exits.
mkdir -p "$ROOT_DIR/.deps"
exec 9>"$ROOT_DIR/.deps/lexbor.lock"
flock 9

if [ ! -f "$LIB" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$LEXBOR_COMMIT" ]; then
	for tool in cmake git; do
		command -v "$tool" >/dev/null || {
			echo "build-lexbor: $tool is required to build lexbor" >&2
			exit 1
		}
	done
	# A private work dir, removed on any exit, so an interrupted build leaves nothing a
	# later one could mistake for its own.
	work=$(mktemp -d "$ROOT_DIR/.deps/lexbor-src.XXXXXX")
	trap 'rm -rf "$work"' EXIT
	rm -rf "$OUT"
	mkdir -p "$OUT"
	git -C "$work" init -q
	git -C "$work" fetch -q --depth 1 "$LEXBOR_REPO" "$LEXBOR_COMMIT"
	git -C "$work" checkout -q FETCH_HEAD
	[ "$(git -C "$work" rev-parse HEAD)" = "$LEXBOR_COMMIT" ] || {
		echo "build-lexbor: fetched tree is not lexbor $LEXBOR_COMMIT" >&2
		exit 1
	}
	cmake -S "$work" -B "$work/build" -DCMAKE_BUILD_TYPE=Release \
		-DLEXBOR_BUILD_SHARED=OFF -DLEXBOR_BUILD_STATIC=ON \
		-DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_INSTALL_PREFIX="$OUT" >/dev/null
	cmake --build "$work/build" -j "$(nproc 2>/dev/null || echo 4)" >/dev/null
	cmake --install "$work/build" >/dev/null
	# Some lexbor versions install into lib64.
	[ -f "$LIB" ] || { mkdir -p "$OUT/lib" && cp "$work/build/liblexbor_static.a" "$LIB"; }
	echo "$LEXBOR_COMMIT" >"$STAMP"
	printf 'built %s\n' ".deps/lexbor (lexbor ${LEXBOR_COMMIT%"${LEXBOR_COMMIT#???????}"})"
fi

if [ ! -f "$SHIM_LIB" ] || [ "$SHIM_SRC" -nt "$SHIM_LIB" ] || [ "$LIB" -nt "$SHIM_LIB" ]; then
	"$CC" -O2 -fPIC -I "$OUT/include" -c "$SHIM_SRC" -o "$OUT/lib/larva_html_shim.o"
	ar rcs "$SHIM_LIB" "$OUT/lib/larva_html_shim.o"
	printf 'built %s\n' ".deps/lexbor/lib/liblarva_html_shim.a"
fi
