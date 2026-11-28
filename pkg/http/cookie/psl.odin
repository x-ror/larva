// The Public Suffix List, as Chrome's cookie and site code consults it
// (net/base/registry_controlled_domains, asked with INCLUDE_PRIVATE_REGISTRIES): which
// part of a host is a registry anyone can register under (`com`, `co.uk`, `github.io`),
// and so which suffix is the host's registrable domain (eTLD+1). The jar uses it to
// refuse a Domain= that names a public suffix (a cookie for every site under `co.uk`)
// and to key a site for the per-site limits and SameSite.
//
// The list is Mozilla's (pkg/http/cookie/psl/public_suffix_list.dat, MPL-2.0; NOTICE
// says which revision and why it may be linked from both the AGPL core and commercial
// extensions). scripts/gen-psl.mjs compiles it into psl/psl.table, a hashed key table
// `#load`ed into rodata: nothing is parsed or allocated at run time, every process
// shares the pages, and a lookup is one hash probe per candidate suffix.
//
// Cost. The table is 225,691 bytes of rodata for 10507 keys (32 KiB of u16 slots,
// 41 KiB of offsets, 147 KiB of keys); bin/lava grows by 233,440 bytes (4,383,776 ->
// 4,617,216, `make build` on #157's head and on this change). Time, measured with a
// scratch -o:speed program cycling eight hosts (www.example.com, example.com,
// a.b.c.example.co.uk, x.github.io, foo.bar.test, x.city.kobe.jp, an IDN host,
// 127.0.0.1), 2M calls per run, 7 runs, x86_64 with 4 cores, warm cache: site_key
// ~77 ns, against ~37 ns for #157's two-label stand-in and ~245 ns for a binary search
// over the same sorted keys (the first layout, dropped for this one); set_cookie with
// `Domain=example.co.uk` from www.example.co.uk ~410 ns, against ~239 ns.
//
// Reuse (CLAUDE.md §2): core: and vendor: carry no list (core:crypto/x509's doc.odin
// says outright it has none). libpsl is on the box as a runtime library only
// (libpsl5t64; no libpsl-dev, so no header or link name, and CI's apt line installs
// none), would add a link plus libidn2/libunistring, and its built-in DAFSA is
// whatever the distro froze it at, so the answer would depend on the machine. Chrome
// ships a pinned list, and so does this.
package larva_cookie

import "core:encoding/endian"
import "core:strings"

// The flags psl.table stores per key (scripts/gen-psl.mjs).
@(private = "file")
RULE_EXACT :: u8(1)
@(private = "file")
RULE_WILDCARD :: u8(2)
@(private = "file")
RULE_EXCEPTION :: u8(4)
@(private = "file")
PSL_HEADER_BYTES :: 56

@(private = "file", rodata)
psl_blob := #load("psl/psl.table")

// registrable_domain returns `host`'s registrable domain — the public suffix plus one
// label — as a view into `host`, or "" when it has none: an IP literal, a host that is
// itself a public suffix (`co.uk`, `github.io`, `kobe.jp` under `*.kobe.jp`), a single
// label, an empty host or one with a leading dot. Case-insensitive; a single trailing
// dot is kept on the result, as Chrome keeps it.
//
// Node:
//   Chrome 158's GetDomainAndRegistry with INCLUDE_PRIVATE_REGISTRIES, read off its
//   behaviour (a --host-resolver-rules probe of Domain= and SameSite=Strict, cited in
//   psl_test.odin): a TLD the list does not know is one label (`a.b.test` -> `b.test`,
//   the PSL's implicit `*` rule), and a wildcard rule's own parent is a suffix too
//   (`kobe.jp` under `*.kobe.jp`), where the PSL algorithm would make it registrable.
//   The publicsuffix.org vectors (psl/test_psl.txt) pass, leading dots included.
registrable_domain :: proc(host: string) -> string {
	if host == "" || host[0] == '.' || is_ip(host) {
		return ""
	}

	h := host

	if h[len(h) - 1] == '.' {
		h = h[:len(h) - 1]
	}

	reg := registry_length(h)

	// The registry plus a dot and at least one byte before it.
	if reg == 0 || reg + 2 > len(h) {
		return ""
	}

	dot := strings.last_index_byte(h[:len(h) - reg - 1], '.')
	return host[dot + 1:]
}

// registry_length is Chrome's GetRegistryLengthInTrimmedHost for a host without
// leading or trailing dots: how many trailing bytes of `h` are its public suffix, 0
// when the whole host is one (or names nothing). The longest matching key decides;
// on it a wildcard beats an exception, which beats an exact rule.
@(private = "file")
registry_length :: proc(h: string) -> int {
	// Only the last max_labels labels can match a key, so start there: a host with a
	// hundred labels costs no more lookups than one with six.
	max_labels := int(endian.unchecked_get_u32le(psl_blob[12:]))
	start := 0
	labels := 0

	for i := len(h) - 1; i >= 0; i -= 1 {
		if h[i] != '.' {
			continue
		}

		labels += 1

		if labels == max_labels {
			start = i + 1
			break
		}
	}

	match_len := 0
	flags := u8(0)

	for s := start; s < len(h); {
		if f := find_rule(h[s:]); f != 0 {
			match_len, flags = len(h) - s, f
			break
		}

		next := strings.index_byte(h[s:], '.')

		if next < 0 {
			break
		}

		s += next + 1
	}

	if flags == 0 {
		// Unlisted TLD: its last label is the registry (INCLUDE_UNKNOWN_REGISTRIES).
		last := strings.last_index_byte(h, '.')
		return 0 if last < 0 else len(h) - last - 1
	}

	if flags & RULE_WILDCARD != 0 {
		if match_len == len(h) {
			return 0
		}

		preceding := strings.last_index_byte(h[:len(h) - match_len - 1], '.')
		return 0 if preceding < 0 else len(h) - preceding - 1
	}

	if flags & RULE_EXCEPTION != 0 {
		// `!city.kobe.jp`: the registry is the key minus its first label.
		first := strings.index_byte(h[len(h) - match_len:], '.')
		return 0 if first < 0 else match_len - first - 1
	}

	return 0 if match_len == len(h) else match_len
}

// find_rule returns the flags psl.table stores for `key` (compared ASCII
// case-insensitively), 0 when the list has no such key: FNV-1a into the slot table,
// then linear probing to an empty slot (scripts/gen-psl.mjs builds it).
@(private = "file")
find_rule :: proc(key: string) -> u8 {
	count := int(endian.unchecked_get_u32le(psl_blob[8:]))
	mask := endian.unchecked_get_u32le(psl_blob[16:]) - 1
	slots := psl_blob[PSL_HEADER_BYTES:]
	offsets := slots[2 * (mask + 1):]
	entries := offsets[4 * (count + 1):]

	h := u32(0x811c9dc5)
	for i in 0 ..< len(key) {
		h = (h ~ u32(ascii_lower(key[i]))) * 0x01000193
	}

	for slot := h & mask;; slot = (slot + 1) & mask {
		v := int(endian.unchecked_get_u16le(slots[2 * slot:]))

		if v == 0 {
			return 0
		}

		at := int(endian.unchecked_get_u32le(offsets[4 * (v - 1):]))
		end := int(endian.unchecked_get_u32le(offsets[4 * v:]))

		if equal_folded(string(entries[at + 1:end]), key) {
			return entries[at]
		}
	}
}

// equal_folded compares `table` (lowercase already) with `key`, key's ASCII letters
// lowered: a host's case never costs a copy.
@(private = "file")
equal_folded :: proc(table, key: string) -> bool {
	if len(table) != len(key) {
		return false
	}

	for i in 0 ..< len(key) {
		if table[i] != ascii_lower(key[i]) {
			return false
		}
	}

	return true
}
