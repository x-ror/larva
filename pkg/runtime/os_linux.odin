#+build linux
package lava_runtime

import "core:os"
import "core:strconv"
import "core:strings"
import "core:sys/linux"
import "core:sys/posix"

// Linux memory/uptime come from the sysinfo(2) syscall (core:sys/linux); per-CPU
// model/speed/times are parsed from /proc, matching what libuv reads. (hostname,
// uname, user, parallelism, loadavg, priority and interfaces are shared POSIX code
// in os_posix.odin.)

@(private = "file")
read_sysinfo :: proc() -> (si: linux.Sys_Info, ok: bool) {
	err := linux.sysinfo(&si)
	return si, err == .NONE
}

// sysinfo reports the *ram fields in units of `mem_unit` bytes (1 on modern
// kernels, larger on machines with huge RAM); fold it in to get a byte count.
@(private = "file")
sysinfo_unit :: proc(si: linux.Sys_Info) -> u64 {
	unit := u64(si.mem_unit)
	if unit == 0 {
		return 1
	}
	return unit
}

os_process_rss_bytes :: proc() -> u64 {
	data, err := os.read_entire_file("/proc/self/statm", context.temp_allocator)
	if err != os.ERROR_NONE || len(data) == 0 {
		return 0
	}
	s := string(data)
	sp := strings.index_byte(s, ' ')
	if sp < 0 {
		return 0
	}
	rest := s[sp + 1:]
	end := strings.index_byte(rest, ' ')
	if end < 0 {
		end = len(rest)
	}
	pages, ok := strconv.parse_u64(rest[:end])
	if !ok {
		return 0
	}
	page := u64(posix.sysconf(._PAGESIZE))
	if page == 0 {
		page = 4096
	}
	return pages * page
}

os_totalmem :: proc() -> u64 {
	si, ok := read_sysinfo()
	if !ok {
		return 0
	}
	return u64(si.totalram) * sysinfo_unit(si)
}

os_freemem :: proc() -> u64 {
	si, ok := read_sysinfo()
	if !ok {
		return 0
	}
	return u64(si.freeram) * sysinfo_unit(si)
}

os_uptime :: proc() -> f64 {
	si, ok := read_sysinfo()
	if !ok {
		return 0
	}
	return f64(si.uptime)
}

// os_avail_parallelism returns the number of CPUs the process may actually run on,
// honoring CPU affinity / cpuset limits — core:os.get_processor_core_count() uses
// sched_getaffinity(2) on Linux, which is what uv_available_parallelism() does. This
// can be smaller than os.cpus().length inside a container or a pinned process; Node
// reports the same split (cpus() = all online CPUs, availableParallelism() = mask).
os_avail_parallelism :: proc() -> int {
	n := os.get_processor_core_count()
	if n < 1 {
		return 1
	}
	return n
}

// clk_tck reads sysconf(_SC_CLK_TCK): the clock-tick rate /proc/stat counts in. It
// is almost always 100 but is configurable, so it is read rather than hardcoded.
// /proc/stat ticks scale to milliseconds (Node reports cpu times in ms) as
// ticks * 1000 / hz.
@(private = "file")
clk_tck :: proc() -> i64 {
	hz := i64(posix.sysconf(._CLK_TCK))
	if hz <= 0 {
		return 100
	}
	return hz
}

// field_i64 returns the n-th (0-based) whitespace-delimited token of `line`
// parsed as an integer, tolerating runs of spaces (the aggregate /proc/stat line
// pads with two). Avoids allocating a split — these lines are scanned hot.
@(private = "file")
field_i64 :: proc(line: string, n: int) -> i64 {
	idx := 0
	i := 0
	for i < len(line) {
		for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
			i += 1
		}
		if i >= len(line) {
			break
		}
		start := i
		for i < len(line) && line[i] != ' ' && line[i] != '\t' {
			i += 1
		}
		if idx == n {
			v, _ := strconv.parse_i64(line[start:i])
			return v
		}
		idx += 1
	}
	return 0
}

@(private = "file")
value_after_colon :: proc(line: string) -> string {
	idx := strings.index_byte(line, ':')
	if idx < 0 {
		return ""
	}
	return strings.trim_space(line[idx + 1:])
}

os_cpus :: proc() -> []Os_Cpu {
	cpus := make([dynamic]Os_Cpu, 0, 8, context.temp_allocator)
	hz := clk_tck()

	// Per-CPU tick counters: the "cpuN" lines of /proc/stat (the bare "cpu " total
	// is skipped). Columns are user, nice, system, idle, iowait, irq, softirq, ...
	if data, err := os.read_entire_file("/proc/stat", context.temp_allocator); err == os.ERROR_NONE {
		for line in strings.split(string(data), "\n", context.temp_allocator) {
			if len(line) < 4 || !strings.has_prefix(line, "cpu") {
				continue
			}
			if line[3] < '0' || line[3] > '9' {
				continue // the aggregate "cpu " line
			}
			append(
				&cpus,
				Os_Cpu {
					user = field_i64(line, 1) * 1000 / hz,
					nice = field_i64(line, 2) * 1000 / hz,
					sys = field_i64(line, 3) * 1000 / hz,
					idle = field_i64(line, 4) * 1000 / hz,
					irq = field_i64(line, 6) * 1000 / hz,
				},
			)
		}
	}

	// Per-CPU model name and MHz: one block per processor in /proc/cpuinfo. "cpu
	// MHz" is absent on some hosts (containers, ARM) — speed stays 0 there, which
	// is exactly what Node reports in the same situation.
	models := make([dynamic]string, 0, 8, context.temp_allocator)
	speeds := make([dynamic]int, 0, 8, context.temp_allocator)
	if data, err := os.read_entire_file("/proc/cpuinfo", context.temp_allocator); err == os.ERROR_NONE {
		cur_model := ""
		cur_speed := 0
		have := false
		for line in strings.split(string(data), "\n", context.temp_allocator) {
			if line == "" {
				if have {
					append(&models, cur_model)
					append(&speeds, cur_speed)
					cur_model = ""
					cur_speed = 0
					have = false
				}
				continue
			}
			have = true
			if strings.has_prefix(line, "model name") {
				cur_model = value_after_colon(line)
			} else if strings.has_prefix(line, "cpu MHz") {
				f, _ := strconv.parse_f64(value_after_colon(line))
				cur_speed = int(f)
			}
		}
		if have {
			append(&models, cur_model)
			append(&speeds, cur_speed)
		}
	}

	// /proc/stat unreadable (no per-CPU lines): fall back to a parallelism-sized
	// list with zero times so os.cpus() is still a non-empty, well-shaped array.
	if len(cpus) == 0 {
		count := os_avail_parallelism()
		for _ in 0 ..< count {
			append(&cpus, Os_Cpu{})
		}
	}

	for i in 0 ..< len(cpus) {
		switch {
		case i < len(models) && models[i] != "":
			cpus[i].model = models[i]
		case len(models) > 0 && models[0] != "":
			cpus[i].model = models[0]
		case:
			cpus[i].model = "unknown"
		}
		switch {
		case i < len(speeds):
			cpus[i].speed = speeds[i]
		case len(speeds) > 0:
			cpus[i].speed = speeds[0]
		}
	}
	return cpus[:]
}
