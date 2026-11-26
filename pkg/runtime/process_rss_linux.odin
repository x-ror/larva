#+build linux
package lava_runtime

import "core:os"
import "core:strconv"
import "core:strings"
import "core:sys/posix"

// os_process_rss_bytes backs process.memoryUsage().rss: the resident page count from
// /proc/self/statm times the page size. 0 when /proc is unreadable — memoryUsage
// reports a number either way. The node:os natives it used to sit beside are gone
// with the Node profile; process stays until the surface itself does.
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
