#+build darwin
package lava_runtime

import "core:c"
import "core:sys/darwin"
import "core:time"

// Darwin memory/uptime/cpus via sysctl (core:sys/darwin exposes sysctl only as the
// raw syscall_sysctlbyname wrapper; there are no mach host-statistics bindings).
// hostname, uname, user, parallelism, loadavg, priority and interfaces are the
// shared POSIX code in os_posix.odin.

foreign import libsystem "system:System"
foreign libsystem {
	getpagesize :: proc() -> c.int ---
}

@(private = "file")
sysctl_u64 :: proc(name: string) -> (u64, bool) {
	v: u64
	size := c.size_t(size_of(u64))

	if darwin.syscall_sysctlbyname(name, &v, &size, nil, 0) != 0 {
		return 0, false
	}

	return v, true
}

@(private = "file")
sysctl_u32 :: proc(name: string) -> (u32, bool) {
	v: u32
	size := c.size_t(size_of(u32))

	if darwin.syscall_sysctlbyname(name, &v, &size, nil, 0) != 0 {
		return 0, false
	}

	return v, true
}

@(private = "file")
sysctl_i32 :: proc(name: string) -> (i32, bool) {
	v: i32
	size := c.size_t(size_of(i32))

	if darwin.syscall_sysctlbyname(name, &v, &size, nil, 0) != 0 {
		return 0, false
	}

	return v, true
}

@(private = "file")
sysctl_string :: proc(name: string) -> string {
	buf: [256]u8
	size := c.size_t(len(buf))

	if darwin.syscall_sysctlbyname(name, raw_data(buf[:]), &size, nil, 0) != 0 {
		return ""
	}

	n := int(size)

	if n > 0 && buf[n - 1] == 0 {
		n -= 1 // sysctl reports the length including the NUL terminator
	}

	if n <= 0 {
		return ""
	}

	out := make([]u8, n, context.temp_allocator)
	copy(out, buf[:n])
	return string(out)
}

// os_avail_parallelism is the online logical CPU count (sysconf's
// _SC_NPROCESSORS_ONLN constant is private in core:sys/posix, so use sysctl).
os_avail_parallelism :: proc() -> int {
	if n, ok := sysctl_i32("hw.logicalcpu"); ok && n > 0 {
		return int(n)
	}

	if m, ok := sysctl_i32("hw.ncpu"); ok && m > 0 {
		return int(m)
	}

	return 1
}

os_process_rss_bytes :: proc() -> u64 {
	// task_info is not bound; fall back to 0 (rss still useful on Linux where we probe).
	return 0
}

os_totalmem :: proc() -> u64 {
	v, ok := sysctl_u64("hw.memsize")

	if !ok {
		return 0
	}

	return v
}

os_freemem :: proc() -> u64 {
	// vm.page_free_count is a 32-bit page count; bytes = pages * page size.
	pages, ok := sysctl_u32("vm.page_free_count")

	if !ok {
		return 0
	}

	page := u64(getpagesize())

	if page == 0 {
		page = 4096
	}

	return u64(pages) * page
}

os_uptime :: proc() -> f64 {
	// kern.boottime is a `struct timeval`; only tv_sec (the first 8 bytes) is
	// needed. Uptime is wall-clock now minus the boot epoch.
	boot: [2]i64
	size := c.size_t(size_of(boot))

	if darwin.syscall_sysctlbyname("kern.boottime", &boot, &size, nil, 0) != 0 {
		return 0
	}

	now := time.now()._nsec / 1_000_000_000

	if now <= boot[0] {
		return 0
	}

	return f64(now - boot[0])
}

os_cpus :: proc() -> []Os_Cpu {
	count := 0

	if n, ok := sysctl_i32("hw.logicalcpu"); ok && n > 0 {
		count = int(n)
	} else if m, ok2 := sysctl_i32("hw.ncpu"); ok2 && m > 0 {
		count = int(m)
	}

	if count < 1 {
		count = 1
	}

	model := sysctl_string("machdep.cpu.brand_string")

	if model == "" {
		model = sysctl_string("hw.model")
	}

	if model == "" {
		model = "unknown"
	}

	speed := 0

	if hz, ok := sysctl_u64("hw.cpufrequency"); ok {
		speed = int(hz / 1_000_000)
	}

	// Per-CPU tick counts require mach host_processor_info, which core:sys/darwin
	// does not bind; report zero times (shape-correct, Node parity on field set).
	cpus := make([]Os_Cpu, count, context.temp_allocator)
	for i in 0 ..< count {
		cpus[i] = Os_Cpu {
			model = model,
			speed = speed,
		}
	}
	return cpus
}
