#!/usr/bin/env sh
set -eu

missing=0

check_pkg() {
	name=$1
	if pkg-config --exists "$name"; then
		printf '%s ' "$name"
		pkg-config --modversion "$name"
	else
		printf 'missing: %s\n' "$name"
		missing=1
	fi
}

check_pkg javascriptcoregtk-6.0
check_pkg sqlite3

# TLS is BoringSSL, built from a pinned commit into .deps/ by scripts/build-boringssl.sh
# (#6): no system OpenSSL to check for. Building it needs cmake.
if ! command -v cmake >/dev/null; then
	printf 'missing: cmake (builds lexbor and BoringSSL)\n'
	missing=1
fi

# pkg/http's content decoding links the system libraries on Linux: zlib through
# vendor:zlib (system:z there), brotli and zstd through content_coding_linux.odin.
if [ "$(uname -s)" = Linux ]; then
	check_pkg zlib
	check_pkg libbrotlidec
	check_pkg libzstd
fi

if [ "$missing" -ne 0 ]; then
	printf '%s\n' 'Install the missing development package before enabling native JSC runtime execution.'
	exit 1
fi
