#!/usr/bin/env sh
set -eu

# Builds BoringSSL (https://boringssl.googlesource.com/boringssl, mirrored at
# github.com/google/boringssl; Apache-2.0, with OpenSSL/ISC-licensed legacy files —
# see NOTICE) as static libssl.a/libcrypto.a for pkg/tls. Pinned to one release tag's
# commit, fetched with git and checked by its commit id, as build-lexbor.sh does and
# for the same reason (a commit id hashes the tree; an archive tarball's bytes are not
# promised stable). Idempotent: does nothing when the archives for this pin exist.
#
# Why BoringSSL and not the system OpenSSL (#6): Chrome's ClientHello — GREASE,
# extension permutation, X25519MLKEM768, brotli certificate compression, ECH GREASE —
# is only reachable through BoringSSL's knobs; OpenSSL 3.0 cannot produce it.
# Why static: no distro ships BoringSSL, and linking it next to a system libssl
# would clash on every SSL_* symbol.
#
# Output (under the gitignored .deps/):
#   .deps/boringssl/lib/libssl.a, libcrypto.a
#   .deps/boringssl/include/openssl/...

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BORINGSSL_REPO=https://github.com/google/boringssl.git
# Release tag 0.20261020.0.
BORINGSSL_COMMIT=d3bf4795ad5b79d646cddf2fec687da5b9b502db

OUT="$ROOT_DIR/.deps/boringssl"
STAMP="$OUT/.commit"

# One build at a time (see build-lexbor.sh).
mkdir -p "$ROOT_DIR/.deps"
exec 9>"$ROOT_DIR/.deps/boringssl.lock"
flock 9

if [ -f "$OUT/lib/libssl.a" ] && [ -f "$OUT/lib/libcrypto.a" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$BORINGSSL_COMMIT" ]; then
	exit 0
fi

for tool in cmake git; do
	command -v "$tool" >/dev/null || {
		echo "build-boringssl: $tool is required to build BoringSSL" >&2
		exit 1
	}
done

work=$(mktemp -d "$ROOT_DIR/.deps/boringssl-src.XXXXXX")
trap 'rm -rf "$work"' EXIT
rm -rf "$OUT"
mkdir -p "$OUT/lib"
git -C "$work" init -q
git -C "$work" fetch -q --depth 1 "$BORINGSSL_REPO" "$BORINGSSL_COMMIT"
git -C "$work" checkout -q FETCH_HEAD
[ "$(git -C "$work" rev-parse HEAD)" = "$BORINGSSL_COMMIT" ] || {
	echo "build-boringssl: fetched tree is not BoringSSL $BORINGSSL_COMMIT" >&2
	exit 1
}
generator=
if command -v ninja >/dev/null; then
	generator=-GNinja
fi
# shellcheck disable=SC2086
cmake -S "$work" -B "$work/build" $generator -DCMAKE_BUILD_TYPE=Release \
	-DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_TESTING=OFF >/dev/null
cmake --build "$work/build" --target ssl crypto -j "$(nproc 2>/dev/null || echo 4)" >/dev/null
cp "$work/build/libssl.a" "$work/build/libcrypto.a" "$OUT/lib/"
# BoringSSL compiles with -ggdb whatever the build type; its debug info would add ~26 MB
# to bin/lava (Odin links with debug info kept), so drop it from the archives.
strip --strip-debug "$OUT/lib/libssl.a" "$OUT/lib/libcrypto.a"
cp -R "$work/include" "$OUT/include"
cp "$work/LICENSE" "$OUT/LICENSE"
echo "$BORINGSSL_COMMIT" >"$STAMP"
printf 'built %s\n' ".deps/boringssl (BoringSSL ${BORINGSSL_COMMIT%"${BORINGSSL_COMMIT#???????}"})"
