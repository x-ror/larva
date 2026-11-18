#!/usr/bin/env sh
set -eu

# Builds lexbor (https://github.com/lexbor/lexbor, Apache-2.0) as a static library for
# pkg/html, and the small C shim next to it (pkg/html/shim). Pinned to one commit and
# checked against its tarball's sha256, so a build never picks up an unreviewed
# lexbor. Idempotent: does nothing when the archive for this pin already exists.
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
LEXBOR_COMMIT=e609d9446f7adf06c67b89dcdc4a7c39430f0bd8
LEXBOR_SHA256=c69fa3f8ea24cc1a9ea8ea295ff2d3c7a2e8347f211d05f8e0bea7e29fba3b33
CC=${CC:-cc}

OUT="$ROOT_DIR/.deps/lexbor"
STAMP="$OUT/.commit"
LIB="$OUT/lib/liblexbor_static.a"
SHIM_SRC="$ROOT_DIR/pkg/html/shim/larva_html.c"
SHIM_LIB="$OUT/lib/liblarva_html_shim.a"

if [ ! -f "$LIB" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$LEXBOR_COMMIT" ]; then
	command -v cmake >/dev/null || {
		echo "build-lexbor: cmake is required to build lexbor" >&2
		exit 1
	}
	work="$ROOT_DIR/.deps/lexbor-src"
	rm -rf "$work" "$OUT"
	mkdir -p "$work" "$OUT"
	tarball="$work/lexbor.tar.gz"
	curl -fsSL -o "$tarball" "https://github.com/lexbor/lexbor/archive/$LEXBOR_COMMIT.tar.gz"
	echo "$LEXBOR_SHA256  $tarball" | sha256sum -c - >/dev/null || {
		echo "build-lexbor: sha256 mismatch for lexbor $LEXBOR_COMMIT" >&2
		exit 1
	}
	tar xzf "$tarball" -C "$work" --strip-components=1
	cmake -S "$work" -B "$work/build" -DCMAKE_BUILD_TYPE=Release \
		-DLEXBOR_BUILD_SHARED=OFF -DLEXBOR_BUILD_STATIC=ON \
		-DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_INSTALL_PREFIX="$OUT" >/dev/null
	cmake --build "$work/build" -j "$(nproc 2>/dev/null || echo 4)" >/dev/null
	cmake --install "$work/build" >/dev/null
	# Some lexbor versions install into lib64.
	[ -f "$LIB" ] || { mkdir -p "$OUT/lib" && cp "$work/build/liblexbor_static.a" "$LIB"; }
	rm -rf "$work"
	echo "$LEXBOR_COMMIT" >"$STAMP"
	printf 'built %s\n' ".deps/lexbor (lexbor ${LEXBOR_COMMIT%"${LEXBOR_COMMIT#???????}"})"
fi

if [ ! -f "$SHIM_LIB" ] || [ "$SHIM_SRC" -nt "$SHIM_LIB" ] || [ "$LIB" -nt "$SHIM_LIB" ]; then
	"$CC" -O2 -fPIC -I "$OUT/include" -c "$SHIM_SRC" -o "$OUT/lib/larva_html_shim.o"
	ar rcs "$SHIM_LIB" "$OUT/lib/larva_html_shim.o"
	printf 'built %s\n' ".deps/lexbor/lib/liblarva_html_shim.a"
fi
