#+build linux, darwin
package lava_runtime

import "core:c"
import "core:fmt"
import "core:strings"
import "core:sys/posix"

// POSIX implementations shared by Linux and Darwin (os.odin's platform procs).
// Everything here is reachable through core:sys/posix except getloadavg and the
// getifaddrs/ifaddrs family, which core:sys/posix does not bind — they are
// declared below against libc (system:c on Linux, system:System on Darwin, the
// same split core:sys/posix itself uses). Memory, uptime and cpus are NOT here:
// they have no portable POSIX call and live in os_linux.odin / os_darwin.odin.

when ODIN_OS == .Darwin {
	foreign import libc "system:System"
} else {
	foreign import libc "system:c"
}

// ifaddrs is the standard getifaddrs node; the layout is identical on glibc and
// the BSD/Darwin libc (next, name, flags, addr, netmask, the dst/broadcast union,
// data). ifa_addr/ifa_netmask are read back through core:sys/posix's OS-correct
// sockaddr structs, so the per-platform sa_len byte is handled for us.
ifaddrs :: struct {
	ifa_next:    ^ifaddrs,
	ifa_name:    cstring,
	ifa_flags:   c.uint,
	ifa_addr:    ^posix.sockaddr,
	ifa_netmask: ^posix.sockaddr,
	ifa_dstaddr: ^posix.sockaddr,
	ifa_data:    rawptr,
}

// IFF_LOOPBACK is 0x8 on both Linux and the BSDs; an interface carrying it is
// reported as `internal: true` (Node parity).
IFF_LOOPBACK :: 0x8

// Link-layer address family + its sockaddr, hand-declared because core:sys/posix's
// sa_family_t only knows INET/INET6/UNIX. getifaddrs emits one link-layer entry per
// interface (AF_PACKET on Linux, AF_LINK on Darwin) carrying the hardware MAC that
// os.networkInterfaces() reports; without walking these the MAC is all-zero.
when ODIN_OS == .Linux {
	AF_LINK_LOCAL :: 17 // AF_PACKET
	// struct sockaddr_ll: the MAC is sll_addr[:sll_halen] (6 bytes for Ethernet).
	sockaddr_ll :: struct {
		sll_family:   u16,
		sll_protocol: u16,
		sll_ifindex:  i32,
		sll_hatype:   u16,
		sll_pkttype:  u8,
		sll_halen:    u8,
		sll_addr:     [8]u8,
	}
} else {
	AF_LINK_LOCAL :: 18 // AF_LINK (Darwin/BSD)
	// struct sockaddr_dl: an 8-byte header, then sdl_data holds the interface name
	// (sdl_nlen bytes) immediately followed by the MAC (sdl_alen bytes). The MAC is
	// read by offset from the sockaddr base, bounded by sdl_len, since sdl_data is
	// variable-length and the kernel sizes the allocation.
	sockaddr_dl :: struct {
		sdl_len:    u8,
		sdl_family: u8,
		sdl_index:  u16,
		sdl_type:   u8,
		sdl_nlen:   u8,
		sdl_alen:   u8,
		sdl_slen:   u8,
		sdl_data:   [12]u8,
	}
}

foreign libc {
	getloadavg :: proc(loadavg: [^]f64, nelem: c.int) -> c.int ---
	getifaddrs :: proc(ifap: ^^ifaddrs) -> c.int ---
	freeifaddrs :: proc(ifa: ^ifaddrs) ---
}

// clone_c_field copies a NUL-terminated fixed C char array (e.g. utsname.sysname)
// into a fresh temp-allocated Odin string, since the source lives on the stack.
@(private = "file")
clone_c_field :: proc(arr: []c.char) -> string {
	n := 0
	for n < len(arr) && arr[n] != 0 {
		n += 1
	}
	out := make([]u8, n, context.temp_allocator)
	for i in 0 ..< n {
		out[i] = u8(arr[i])
	}
	return string(out)
}

// clone_cstring copies a libc-owned cstring (passwd fields, ifa_name) into temp
// memory so it survives the getpwuid static buffer / freeifaddrs.
@(private = "file")
clone_cstring :: proc(s: cstring) -> string {
	if s == nil {
		return ""
	}

	return strings.clone(string(s), context.temp_allocator)
}

os_hostname :: proc() -> string {
	buf: [256]c.char

	if posix.gethostname(raw_data(buf[:]), len(buf)) != .OK {
		return ""
	}

	return clone_c_field(buf[:])
}

os_uname :: proc(field: Uname_Field) -> string {
	u: posix.utsname

	if posix.uname(&u) != 0 {
		return ""
	}

	switch field {
	case .SYSNAME:
		return clone_c_field(u.sysname[:])
	case .RELEASE:
		return clone_c_field(u.release[:])
	case .VERSION:
		return clone_c_field(u.version[:])
	case .MACHINE:
		return clone_c_field(u.machine[:])
	}
	return ""
}

os_loadavg :: proc() -> [3]f64 {
	out: [3]f64

	if getloadavg(raw_data(out[:]), 3) != 3 {
		return {0, 0, 0}
	}

	return out
}

os_user_info :: proc() -> Os_User_Info {
	uid := posix.getuid()
	gid := posix.getgid()
	ui := Os_User_Info {
		uid = int(u32(uid)),
		gid = int(u32(gid)),
	}
	pw := posix.getpwuid(uid)

	if pw != nil {
		ui.username = clone_cstring(pw.pw_name)
		ui.homedir = clone_cstring(pw.pw_dir)

		if pw.pw_shell != nil && len(string(pw.pw_shell)) > 0 {
			ui.shell = clone_cstring(pw.pw_shell)
			ui.has_shell = true
		}
	}

	// Fall back to the environment when there is no passwd entry (e.g. a bare
	// container UID); Node would throw here, but a best-effort answer is friendlier.
	if ui.username == "" {
		ui.username = os_getenv_or("USER", os_getenv_or("LOGNAME", ""))
	}

	if ui.homedir == "" {
		ui.homedir = os_getenv_or("HOME", "")
	}

	return ui
}

// os_get_priority returns the nice value and an errno (0 on success). getpriority
// can legitimately return -1 as a real priority, so the only reliable failure test
// is the documented one: clear errno, call, then check for -1 *with* a set errno
// (e.g. ESRCH for an unknown pid). This lets the caller distinguish a -1 priority
// from a failed lookup.
os_get_priority :: proc(pid: int) -> (value: int, err: int) {
	posix.set_errno(.NONE)
	v := posix.getpriority(.PROCESS, posix.id_t(pid))

	if v == -1 {
		if e := posix.errno(); e != .NONE {
			return 0, int(e)
		}
	}

	return int(v), 0
}

// os_set_priority returns 0 on success or the errno from a failed setpriority
// (EPERM when lowering another user's nice value, ESRCH for an unknown pid).
os_set_priority :: proc(pid: int, value: int) -> (err: int) {
	posix.set_errno(.NONE)

	if posix.setpriority(.PROCESS, posix.id_t(pid), c.int(value)) != .OK {
		e := posix.errno()

		if e == .NONE {
			e = .EPERM
		}

		return int(e)
	}

	return 0
}

// os_network_interfaces walks getifaddrs and emits one flat record per IPv4/IPv6
// address. A first pass caches each interface's hardware MAC from its link-layer
// entry (AF_PACKET/AF_LINK); a second pass builds the address records and attaches
// the cached MAC (all-zero when the interface exposes no link-layer address, as in
// Node). js/node/os.js groups them by name and adds the family string + CIDR.
os_network_interfaces :: proc() -> []Os_Net_Iface {
	head: ^ifaddrs

	if getifaddrs(&head) != 0 || head == nil {
		return nil
	}

	defer freeifaddrs(head)

	macs := make(map[string]string, 8, context.temp_allocator)
	for cur := head; cur != nil; cur = cur.ifa_next {
		if cur.ifa_addr == nil || int(cur.ifa_addr.sa_family) != AF_LINK_LOCAL {
			continue
		}

		if mac, ok := link_mac(cur.ifa_addr); ok {
			macs[clone_cstring(cur.ifa_name)] = mac
		}
	}

	out := make([dynamic]Os_Net_Iface, 0, 8, context.temp_allocator)
	for cur := head; cur != nil; cur = cur.ifa_next {
		if cur.ifa_addr == nil {
			continue
		}

		family := cur.ifa_addr.sa_family
		name := clone_cstring(cur.ifa_name)
		mac := "00:00:00:00:00:00"

		if m, ok := macs[name]; ok {
			mac = m
		}

		rec := Os_Net_Iface {
			name     = name,
			mac      = mac,
			internal = (cur.ifa_flags & IFF_LOOPBACK) != 0,
		}
		#partial switch family {
		case .INET:
			a := cast(^posix.sockaddr_in)cur.ifa_addr
			rec.family = 4
			rec.address = format_v4(a.sin_addr.s_addr)

			if cur.ifa_netmask != nil {
				m := cast(^posix.sockaddr_in)cur.ifa_netmask
				rec.netmask = format_v4(m.sin_addr.s_addr)
			}
		case .INET6:
			a := cast(^posix.sockaddr_in6)cur.ifa_addr
			rec.family = 6
			rec.address = format_v6(&a.sin6_addr)
			rec.scopeid = u32(a.sin6_scope_id)

			if cur.ifa_netmask != nil {
				m := cast(^posix.sockaddr_in6)cur.ifa_netmask
				rec.netmask = format_v6(&m.sin6_addr)
			}
		case:
			continue
		}
		append(&out, rec)
	}
	return out[:]
}

// link_mac extracts the hardware address from a link-layer sockaddr (the family is
// AF_LINK_LOCAL). Returns false when the interface has no MAC (e.g. loopback,
// sll_halen/sdl_alen == 0), in which case the caller keeps the all-zero default.
@(private = "file")
link_mac :: proc(sa: ^posix.sockaddr) -> (string, bool) {
	when ODIN_OS == .Linux {
		ll := cast(^sockaddr_ll)sa
		n := int(ll.sll_halen)

		if n <= 0 || n > len(ll.sll_addr) {
			return "", false
		}

		return format_mac(ll.sll_addr[:n]), true
	} else {
		dl := cast(^sockaddr_dl)sa
		n := int(dl.sdl_alen)
		start := 8 + int(dl.sdl_nlen)

		if n <= 0 || start + n > int(dl.sdl_len) {
			return "", false
		}

		base := cast([^]u8)sa
		return format_mac(base[start:start + n]), true
	}
}

// format_mac renders raw hardware-address bytes as lowercase colon-separated hex
// ("a1:b2:..."), matching Node/libuv. Length follows the address (6 for Ethernet).
@(private = "file")
format_mac :: proc(b: []u8) -> string {
	if len(b) == 0 {
		return "00:00:00:00:00:00"
	}

	hex := "0123456789abcdef"
	out := make([]u8, len(b) * 3 - 1, context.temp_allocator)
	j := 0
	for x, i in b {
		if i > 0 {
			out[j] = ':'
			j += 1
		}

		out[j] = hex[x >> 4]
		out[j + 1] = hex[x & 0xf]
		j += 2
	}
	return string(out)
}

// format_v4 renders a network-order in_addr (u32be) as "a.b.c.d".
@(private = "file")
format_v4 :: proc(addr: posix.in_addr_t) -> string {
	b := transmute([4]u8)addr
	return fmt.tprintf("%d.%d.%d.%d", b[0], b[1], b[2], b[3])
}

// format_v6 renders an in6_addr via inet_ntop, yielding the canonical RFC 5952
// compressed form Node/libuv emit (e.g. "::1", "fe80::1"), rather than the
// uncompressed eight-group string. Drives both the address and the IPv6 netmask.
@(private = "file")
format_v6 :: proc(addr: rawptr) -> string {
	buf: [posix.INET6_ADDRSTRLEN]u8
	res := posix.inet_ntop(.INET6, addr, raw_data(buf[:]), posix.socklen_t(len(buf)))

	if res == nil {
		return ""
	}

	return strings.clone(string(res), context.temp_allocator)
}
