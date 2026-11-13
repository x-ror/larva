#+build windows
package lava_runtime

import "core:fmt"
import "core:strings"
import "core:sys/windows"

// Windows implementations of os.odin's platform procs. The node-compat os oracle
// (tests/node-compat/cases/35-os.js) runs here too and branches on
// process.platform for the few values that differ, so this layer aims for Node
// parity: memory, cpu count/model/speed/times, uptime, priority, the OS version
// strings and the full networkInterfaces walk are all real. Only the POSIX-shaped
// uid/gid (-1, as Node) and the absent load average ([0,0,0], as Node) stay stubbed
// because Windows has no equivalent.

foreign import kernel32 "system:Kernel32.lib"
@(default_calling_convention = "stdcall")
foreign kernel32 {
	GetTickCount64 :: proc() -> u64 ---
	// Not in core:sys/windows; hand-declared like GetTickCount64 above.
	GetPriorityClass :: proc(hProcess: windows.HANDLE) -> windows.DWORD ---
	SetPriorityClass :: proc(hProcess: windows.HANDLE, dwPriorityClass: windows.DWORD) -> windows.BOOL ---
	// Same; thread_cpu_ns (vm_cpu_windows.odin) reads the page CPU budget clock here.
	GetThreadTimes :: proc(hThread: windows.HANDLE, lpCreationTime, lpExitTime, lpKernelTime, lpUserTime: ^windows.FILETIME) -> windows.BOOL ---
}

// NtQuerySystemInformation (per-CPU tick counts) is not in core:sys/windows;
// RtlGetVersion is (windows.RtlGetVersion). ntdll.lib is in the Windows SDK and is
// pulled into the link by these references.
foreign import ntdll "system:ntdll.lib"
@(default_calling_convention = "system")
foreign ntdll {
	NtQuerySystemInformation :: proc(info_class: u32, info: rawptr, info_len: u32, ret_len: ^u32) -> windows.NTSTATUS ---
}

// inet_ntop renders an address in the canonical RFC 5952 form (compressed,
// lowercase IPv6) exactly as libuv/Node do; it needs no WSAStartup. ws2_32.lib is
// already in the link set.
foreign import ws2_32 "system:ws2_32.lib"
@(default_calling_convention = "stdcall")
foreign ws2_32 {
	inet_ntop :: proc(family: i32, addr: rawptr, dst: [^]u8, size: uint) -> cstring ---
}

when ODIN_ARCH == .amd64 {
	WIN_MACHINE :: "x86_64"
} else when ODIN_ARCH == .arm64 {
	WIN_MACHINE :: "arm64"
} else when ODIN_ARCH == .i386 {
	WIN_MACHINE :: "i686"
} else {
	WIN_MACHINE :: "unknown"
}

// The libuv nice-value band (UV_PRIORITY_*), identical to the values Node reports
// and accepts on every platform. Windows has no nice values, so get/setPriority
// translate between this band and the six Windows priority classes exactly as
// libuv does, so Lava and Node agree on Windows too.
WIN_PRIORITY_HIGHEST :: -20
WIN_PRIORITY_HIGH :: -14
WIN_PRIORITY_ABOVE_NORMAL :: -7
WIN_PRIORITY_NORMAL :: 0
WIN_PRIORITY_BELOW_NORMAL :: 10
WIN_PRIORITY_LOW :: 19

// IANA ifType for a software loopback adapter; an interface with it is reported as
// `internal: true` (Node parity, mirroring IFF_LOOPBACK on POSIX).
IF_TYPE_SOFTWARE_LOOPBACK :: 24

// GetAdaptersAddresses signals "your buffer was too small, here is the size" with
// ERROR_BUFFER_OVERFLOW; core:sys/windows defines ERROR_SUCCESS but not this one.
ERROR_BUFFER_OVERFLOW :: 111

// SystemProcessorPerformanceInformation class id for NtQuerySystemInformation.
SYSTEM_PROCESSOR_PERFORMANCE_INFO_CLASS :: 8

// Registry location the OS-version accessors read; per-core CPU keys are built by
// cpu_reg_key.
REG_CURRENT_VERSION :: "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"

// One NtQuerySystemInformation(SystemProcessorPerformanceInformation) record: the
// per-CPU tick counts in 100-ns units. KernelTime includes IdleTime (as on POSIX).
System_Processor_Perf_Info :: struct {
	IdleTime:       i64,
	KernelTime:     i64,
	UserTime:       i64,
	DpcTime:        i64,
	InterruptTime:  i64,
	InterruptCount: u32,
}

os_hostname :: proc() -> string {
	return os_getenv_or("COMPUTERNAME", "localhost")
}

os_uname :: proc(field: Uname_Field) -> string {
	switch field {
	case .SYSNAME:
		return "Windows_NT"
	case .RELEASE:
		major, minor, build := win_os_version()
		return fmt.tprintf("%d.%d.%d", major, minor, build)
	case .VERSION:
		return win_product_name()
	case .MACHINE:
		return WIN_MACHINE
	}
	return ""
}

os_process_rss_bytes :: proc() -> u64 {
	// Working set via GetProcessMemoryInfo would need psapi; 0 until bound.
	return 0
}

os_totalmem :: proc() -> u64 {
	status: windows.MEMORYSTATUSEX
	status.dwLength = windows.DWORD(size_of(windows.MEMORYSTATUSEX))
	if !windows.GlobalMemoryStatusEx(&status) {
		return 0
	}
	return u64(status.ullTotalPhys)
}

os_freemem :: proc() -> u64 {
	status: windows.MEMORYSTATUSEX
	status.dwLength = windows.DWORD(size_of(windows.MEMORYSTATUSEX))
	if !windows.GlobalMemoryStatusEx(&status) {
		return 0
	}
	return u64(status.ullAvailPhys)
}

os_uptime :: proc() -> f64 {
	return f64(GetTickCount64()) / 1000.0
}

os_loadavg :: proc() -> [3]f64 {
	return {0, 0, 0} // Windows has no load average; Node also returns [0, 0, 0].
}

// os_avail_parallelism returns the logical-processor count of the current processor
// group (GetSystemInfo.dwNumberOfProcessors). It deliberately does NOT honor process
// affinity: libuv's uv_available_parallelism behaves identically on Windows (only
// the Linux path factors in affinity/cgroup limits), so this matches Node. Keep it
// that way — os_cpus reports one record per this same count, exactly as libuv
// derives both from dwNumberOfProcessors.
os_avail_parallelism :: proc() -> int {
	si: windows.SYSTEM_INFO
	windows.GetSystemInfo(&si)
	n := int(si.dwNumberOfProcessors)
	if n < 1 {
		return 1
	}
	return n
}

// os_cpus reports one record per logical processor (the same count
// os_avail_parallelism uses — libuv derives both from dwNumberOfProcessors). Brand
// and nominal speed are read per-core from the CentralProcessor registry keys
// (falling back to core 0, then env PROCESSOR_IDENTIFIER) so heterogeneous/hybrid
// CPUs report their real per-core values; the per-CPU tick counts come from
// NtQuerySystemInformation, converted from 100-ns units to the milliseconds Node
// reports. A failed times query leaves the times zeroed (Node tolerates this).
os_cpus :: proc() -> []Os_Cpu {
	count := os_avail_parallelism()

	// Core 0 supplies the fallback brand/speed for any core lacking its own key.
	model0 := reg_get_string(cpu_reg_key(0), "ProcessorNameString")
	if model0 == "" {
		model0 = os_getenv_or("PROCESSOR_IDENTIFIER", "unknown")
	}
	speed0 := 0
	if mhz, ok := reg_get_dword(cpu_reg_key(0), "~MHz"); ok {
		speed0 = int(mhz)
	}

	perf := make([]System_Processor_Perf_Info, count, context.temp_allocator)
	got := 0
	ret_len: u32
	if NtQuerySystemInformation(
		   SYSTEM_PROCESSOR_PERFORMANCE_INFO_CLASS,
		   raw_data(perf),
		   u32(count * size_of(System_Processor_Perf_Info)),
		   &ret_len,
	   ) ==
	   0 {
		got = int(ret_len) / size_of(System_Processor_Perf_Info)
	}

	cpus := make([]Os_Cpu, count, context.temp_allocator)
	for i in 0 ..< count {
		key := cpu_reg_key(i)
		model := reg_get_string(key, "ProcessorNameString")
		if model == "" {
			model = model0
		}
		speed := speed0
		if mhz, ok := reg_get_dword(key, "~MHz"); ok {
			speed = int(mhz)
		}
		c := Os_Cpu {
			model = model,
			speed = speed,
		}
		if i < got {
			p := perf[i]
			c.user = p.UserTime / 10000
			c.sys = (p.KernelTime - p.IdleTime) / 10000 // KernelTime includes idle
			c.idle = p.IdleTime / 10000
			c.irq = p.InterruptTime / 10000
		}
		cpus[i] = c
	}
	return cpus
}

os_user_info :: proc() -> Os_User_Info {
	// Windows has no uid/gid; Node reports -1 for both and a null shell.
	return Os_User_Info {
		uid = -1,
		gid = -1,
		username = os_getenv_or("USERNAME", ""),
		homedir = os_getenv_or("USERPROFILE", ""),
		has_shell = false,
	}
}

// os_network_interfaces walks GetAdaptersAddresses and emits one flat record per
// unicast IPv4/IPv6 address, with the adapter's hardware MAC (all-zero for an
// adapter that exposes none, e.g. loopback) and the netmask derived from the
// on-link prefix length. js/internal/os.js groups them by name and adds the family
// string + CIDR.
os_network_interfaces :: proc() -> []Os_Net_Iface {
	flags := windows.GAA_Flags{.Skip_Anycast, .Skip_Multicast, .Skip_DNS_Server}
	size: u32 = 16384
	buf := make([]u8, size, context.temp_allocator)
	base := cast([^]windows.IP_Adapter_Addresses)raw_data(buf)
	ret := windows.GetAdaptersAddresses(.Unspecified, flags, nil, base, &size)
	if ret == ERROR_BUFFER_OVERFLOW {
		buf = make([]u8, size, context.temp_allocator)
		base = cast([^]windows.IP_Adapter_Addresses)raw_data(buf)
		ret = windows.GetAdaptersAddresses(.Unspecified, flags, nil, base, &size)
	}
	if ret != windows.ERROR_SUCCESS {
		return nil
	}

	out := make([dynamic]Os_Net_Iface, 0, 8, context.temp_allocator)
	for adapter := &base[0]; adapter != nil; adapter = adapter.Next {
		// Only operational adapters, matching libuv/Node (skips disconnected NICs).
		if adapter.OperStatus != .Up {
			continue
		}
		name, _ := windows.wstring_to_utf8(adapter.FriendlyName, -1, context.temp_allocator)
		internal := adapter.IfType == IF_TYPE_SOFTWARE_LOOPBACK
		// Node/libuv report a MAC only for a standard 6-byte hardware address;
		// loopback / tunnel adapters (other lengths) are reported as all-zero.
		mac := "00:00:00:00:00:00"
		if adapter.PhysicalAddressLength == 6 {
			mac = format_mac(adapter.PhysicalAddress[:6])
		}
		for ua := adapter.FirstUnicastAddress; ua != nil; ua = ua.Next {
			sa := ua.Address.lpSockaddr
			if sa == nil {
				continue
			}
			rec := Os_Net_Iface {
				name     = name,
				mac      = mac,
				internal = internal,
			}
			switch int(sa.sa_family) {
			case int(windows.AF_INET):
				a := cast(^windows.sockaddr_in)sa
				rec.family = 4
				rec.address = format_v4(a.sin_addr.s_addr)
				rec.netmask = v4_mask(ua.OnLinkPrefixLength)
			case int(windows.AF_INET6):
				a := cast(^windows.sockaddr_in6)sa
				rec.family = 6
				rec.address = format_v6(&a.sin6_addr)
				rec.scopeid = u32(a.sin6_scope_id)
				rec.netmask = v6_mask(ua.OnLinkPrefixLength)
			case:
				continue
			}
			append(&out, rec)
		}
	}
	return out[:]
}

// os_get_priority maps the process's priority class to the libuv nice band and
// returns 0 on success. An unknown pid fails OpenProcess -> nonzero errno, which
// js/internal/os.js surfaces as ERR_SYSTEM_ERROR (matching Node). pid 0 means the
// current process: GetCurrentProcess returns a pseudo-handle needing no close.
os_get_priority :: proc(pid: int) -> (value: int, err: int) {
	current := pid == 0
	handle := current ? windows.GetCurrentProcess() : windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, windows.FALSE, windows.DWORD(pid))
	if handle == nil {
		return 0, win_errno(windows.GetLastError())
	}
	defer if !current do windows.CloseHandle(handle)

	switch GetPriorityClass(handle) {
	case 0:
		return 0, win_errno(windows.GetLastError())
	case windows.REALTIME_PRIORITY_CLASS:
		return WIN_PRIORITY_HIGHEST, 0
	case windows.HIGH_PRIORITY_CLASS:
		return WIN_PRIORITY_HIGH, 0
	case windows.ABOVE_NORMAL_PRIORITY_CLASS:
		return WIN_PRIORITY_ABOVE_NORMAL, 0
	case windows.BELOW_NORMAL_PRIORITY_CLASS:
		return WIN_PRIORITY_BELOW_NORMAL, 0
	case windows.IDLE_PRIORITY_CLASS:
		return WIN_PRIORITY_LOW, 0
	case:
		return WIN_PRIORITY_NORMAL, 0 // NORMAL_PRIORITY_CLASS + any unlisted class
	}
}

// os_set_priority maps the nice band to a Windows priority class (the same
// thresholds libuv uses) and returns 0 on success, or the errno from a failed
// OpenProcess/SetPriorityClass (unknown pid, insufficient rights). os.odin's caller
// has already validated value into [-20, 19].
os_set_priority :: proc(pid: int, value: int) -> (err: int) {
	cls: windows.DWORD
	switch {
	case value < WIN_PRIORITY_HIGH:
		cls = windows.REALTIME_PRIORITY_CLASS
	case value < WIN_PRIORITY_ABOVE_NORMAL:
		cls = windows.HIGH_PRIORITY_CLASS
	case value < WIN_PRIORITY_NORMAL:
		cls = windows.ABOVE_NORMAL_PRIORITY_CLASS
	case value < WIN_PRIORITY_BELOW_NORMAL:
		cls = windows.NORMAL_PRIORITY_CLASS
	case value < WIN_PRIORITY_LOW:
		cls = windows.BELOW_NORMAL_PRIORITY_CLASS
	case:
		cls = windows.IDLE_PRIORITY_CLASS
	}

	current := pid == 0
	handle :=
		current ? windows.GetCurrentProcess() : windows.OpenProcess(windows.PROCESS_SET_INFORMATION, windows.FALSE, windows.DWORD(pid))
	if handle == nil {
		return win_errno(windows.GetLastError())
	}
	defer if !current do windows.CloseHandle(handle)

	if !SetPriorityClass(handle, cls) {
		return win_errno(windows.GetLastError())
	}
	return 0
}

// --- file-private helpers ---------------------------------------------------

// win_os_version returns the real OS version triple via RtlGetVersion (which,
// unlike GetVersionEx, is not subject to application-manifest shimming).
@(private = "file")
win_os_version :: proc() -> (major, minor, build: u32) {
	osvi: windows.OSVERSIONINFOEXW
	osvi.dwOSVersionInfoSize = u32(size_of(windows.OSVERSIONINFOEXW))
	if windows.RtlGetVersion(&osvi) == 0 { 	// STATUS_SUCCESS
		return osvi.dwMajorVersion, osvi.dwMinorVersion, osvi.dwBuildNumber
	}
	return 10, 0, 0
}

// win_product_name returns the registry ProductName ("Windows 11 Pro"). The
// registry value still reads "Windows 10 ..." on Windows 11, so apply the same
// build >= 22000 fixup Node/libuv do.
@(private = "file")
win_product_name :: proc() -> string {
	name := reg_get_string(REG_CURRENT_VERSION, "ProductName")
	if name == "" {
		return "Windows"
	}
	if _, _, build := win_os_version(); build >= 22000 && strings.has_prefix(name, "Windows 10") {
		return fmt.tprintf("Windows 11%s", name[len("Windows 10"):])
	}
	return name
}

// reg_get_string reads a REG_SZ value under HKLM, returning "" on any failure.
@(private = "file")
reg_get_string :: proc(subkey, value: string) -> string {
	wsub := windows.utf8_to_wstring(subkey, context.temp_allocator)
	wval := windows.utf8_to_wstring(value, context.temp_allocator)
	size: windows.DWORD
	if windows.RegGetValueW(
		   windows.HKEY_LOCAL_MACHINE,
		   wsub,
		   wval,
		   windows.RRF_RT_REG_SZ,
		   nil,
		   nil,
		   &size,
	   ) !=
		   0 ||
	   size < 2 {
		return ""
	}
	buf := make([]u16, int(size) / 2, context.temp_allocator)
	if windows.RegGetValueW(
		   windows.HKEY_LOCAL_MACHINE,
		   wsub,
		   wval,
		   windows.RRF_RT_REG_SZ,
		   nil,
		   rawptr(raw_data(buf)),
		   &size,
	   ) !=
	   0 {
		return ""
	}
	s, _ := windows.utf16_to_utf8(buf[:], context.temp_allocator)
	return s
}

// reg_get_dword reads a REG_DWORD value under HKLM.
@(private = "file")
reg_get_dword :: proc(subkey, value: string) -> (u32, bool) {
	wsub := windows.utf8_to_wstring(subkey, context.temp_allocator)
	wval := windows.utf8_to_wstring(value, context.temp_allocator)
	data: windows.DWORD
	size := windows.DWORD(size_of(data))
	if windows.RegGetValueW(
		   windows.HKEY_LOCAL_MACHINE,
		   wsub,
		   wval,
		   windows.RRF_RT_REG_DWORD,
		   nil,
		   rawptr(&data),
		   &size,
	   ) !=
	   0 {
		return 0, false
	}
	return u32(data), true
}

// cpu_reg_key builds the per-logical-processor CentralProcessor registry path.
@(private = "file")
cpu_reg_key :: proc(i: int) -> string {
	return fmt.tprintf("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\%d", i)
}

// win_errno maps the Win32 errors the priority syscalls raise onto the POSIX errno
// numbers os.constants.errno exposes, so a failure reports the same errno on Windows
// as on the POSIX path (e.g. an unknown pid -> ESRCH) instead of a raw Win32 code.
// Note this is the POSIX errno, not libuv's Windows-specific code: Node reports the
// libuv code (e.g. UV_ESRCH == -4040 on Windows), so the numeric errno still differs
// from Node there, but the meaning and the cross-platform Lava value now agree.
@(private = "file")
win_errno :: proc(gle: windows.DWORD) -> int {
	ESRCH :: 3
	EACCES :: 13
	EINVAL :: 22
	switch gle {
	case windows.ERROR_INVALID_PARAMETER: // OpenProcess on a non-existent pid
		return ESRCH
	case windows.ERROR_ACCESS_DENIED:
		return EACCES
	case:
		return EINVAL
	}
}

// format_mac renders raw hardware-address bytes as lowercase colon-separated hex
// ("a1:b2:..."), matching Node/libuv.
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

// format_v4 renders a network-order IPv4 address (u32) as "a.b.c.d".
@(private = "file")
format_v4 :: proc(s_addr: u32) -> string {
	b := transmute([4]u8)s_addr
	return fmt.tprintf("%d.%d.%d.%d", b[0], b[1], b[2], b[3])
}

// format_v6 renders an in6_addr via inet_ntop, yielding the canonical RFC 5952
// compressed form Node emits (e.g. "::1", "fe80::1"). Drives the IPv6 netmask too.
@(private = "file")
format_v6 :: proc(addr: ^windows.in6_addr) -> string {
	buf: [64]u8
	res := inet_ntop(windows.AF_INET6, addr, raw_data(buf[:]), uint(len(buf)))
	if res == nil {
		return ""
	}
	return strings.clone(string(res), context.temp_allocator)
}

// v4_mask renders the IPv4 netmask for an on-link prefix length (e.g. 24 ->
// "255.255.255.0"); js/internal/os.js counts its set bits back into the CIDR.
@(private = "file")
v4_mask :: proc(prefix: u8) -> string {
	b: [4]u8
	p := min(int(prefix), 32)
	for i in 0 ..< 4 {
		b[i] = mask_byte(p - i * 8)
	}
	return fmt.tprintf("%d.%d.%d.%d", b[0], b[1], b[2], b[3])
}

// v6_mask renders the IPv6 netmask for an on-link prefix length (e.g. 64 ->
// "ffff:ffff:ffff:ffff::") through the same inet_ntop path as the address.
@(private = "file")
v6_mask :: proc(prefix: u8) -> string {
	m: windows.in6_addr
	p := min(int(prefix), 128)
	for i in 0 ..< 16 {
		m.s6_addr[i] = mask_byte(p - i * 8)
	}
	return format_v6(&m)
}

// mask_byte is the netmask byte covering `bits` leading bits of an octet: 0xff when
// the whole octet is inside the prefix, 0 when fully outside, a partial mask between.
@(private = "file")
mask_byte :: proc(bits: int) -> u8 {
	switch {
	case bits >= 8:
		return 0xff
	case bits <= 0:
		return 0
	case:
		return u8(0xff << uint(8 - bits))
	}
}
