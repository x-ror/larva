#+build linux, darwin
package main

import "core:fmt"
import "core:os"
import "core:testing"
import http "lava:pkg/http"
import profile "lava:pkg/profile"
import lava "lava:pkg/runtime"

// Pins what no Chrome recording can show about location/history/navigator
// (internal/location.js, internal/navigator.js): the page URL without a usable
// `--origin`, the navigations Larva does not perform (Location's and History's
// @deviates), and that navigator reports the client profile — the table pkg/http takes
// its User-Agent from — rather than the host. Each script throws from the top level, or
// from a timer, on a mismatch, so a regression is an Execution_Error naming it.

@(private = "file")
run_window_script :: proc(t: ^testing.T, name: string, source: string, origin := "") {
	path := fmt.aprintf("/tmp/lava-window-env-%d-%s.js", os.get_pid(), name)
	defer delete(path)

	if err := os.write_entire_file(path, transmute([]u8)source); err != nil {
		testing.expectf(t, false, "%s: cannot write %s: %v", name, path, err)
		return
	}

	defer os.remove(path)
	result := lava.run_file(path, origin = origin)
	defer lava.result_destroy(&result)
	testing.expectf(t, result.status == .Ok, "%s: status=%v message=%q", name, result.status, result.message)
}

// The embedder's value is the page URL; an origin is its root, and no value or one that
// does not parse is about:blank with an opaque origin.
@(test)
window_env_page_url :: proc(t: ^testing.T) {
	CHECK :: `const want = %q;
if (location.href !== want) throw new Error('href ' + location.href);
if (String(location) !== want) throw new Error('toString ' + location);
if (location.origin !== %q) throw new Error('origin ' + location.origin);
if (history.length !== 1 || history.state !== null) throw new Error('history ' + history.length);
`


	cases := [?]struct {
		name, origin, href, serialized: string,
	} {
		{"none", "", "about:blank", "null"},
		{"unparsable", "not a url", "about:blank", "null"},
		{"origin", "http://a.test:8080", "http://a.test:8080/", "http://a.test:8080"},
		{"url", "https://b.test/p/q?x=1#f", "https://b.test/p/q?x=1#f", "https://b.test"},
	}

	for c in cases {
		source := fmt.aprintf(CHECK, c.href, c.serialized)
		defer delete(source)
		run_window_script(t, c.name, source, c.origin)
	}
}

// A navigation to another document is not performed (Location's @deviates): the page
// keeps its URL and its session history, synchronously and after the loop turns. Nor are
// a reload (go(0), reload()) and a traversal past this document's entries.
@(test)
window_env_cross_document_navigation_not_performed :: proc(t: ^testing.T) {
	SOURCE :: `const start = location.href;
const expect = (what) => {
  if (location.href !== start || history.length !== 1) throw new Error(what + ': ' + location.href + ' ' + history.length);
};
location.assign('/other'); expect('assign');
location.replace('http://elsewhere.test/'); expect('replace');
location.href = '/z'; expect('href');
location = '/y'; expect('location');
location.pathname = '/q'; expect('pathname');
location.search = '?s'; expect('search');
location.host = 'elsewhere.test'; expect('host');
location.reload(); expect('reload');
location.assign('javascript:void 0'); expect('javascript:');
history.go(0); history.back(); history.forward(); history.go(5);
setTimeout(() => expect('traversal'), 20);
`


	run_window_script(t, "cross-document", SOURCE, "http://a.test/page")
}

// navigator, screen and the window geometry are the profile's on every host, and the
// User-Agent is the one pkg/http sends.
@(test)
window_env_reports_the_profile :: proc(t: ^testing.T) {
	// Braces doubled: core:fmt reads `{` as the start of an argument index.
	CHECK :: `const check = (o, pairs) => pairs.forEach(([k, v]) => {{
  if (o[k] !== v) throw new Error(k + ' ' + o[k]);
}});
check(navigator, [['userAgent', %q], ['platform', %q], ['vendor', %q], ['language', %q],
  ['hardwareConcurrency', %d], ['maxTouchPoints', %d], ['deviceMemory', %v], ['webdriver', false]]);
check(screen, [['width', %d], ['height', %d], ['availWidth', %d], ['availHeight', %d], ['colorDepth', %d]]);
check(globalThis, [['innerWidth', %d], ['innerHeight', %d], ['outerWidth', %d], ['outerHeight', %d],
  ['devicePixelRatio', %v]]);
`


	p := profile.default_profile()
	testing.expect_value(t, p.user_agent, http.DEFAULT_USER_AGENT)
	source := fmt.aprintf(
		CHECK,
		http.DEFAULT_USER_AGENT,
		p.platform,
		p.vendor,
		p.languages[0],
		p.hardware_concurrency,
		p.max_touch_points,
		p.device_memory,
		p.screen.width,
		p.screen.height,
		p.screen.avail_width,
		p.screen.avail_height,
		p.screen.color_depth,
		p.window.inner_width,
		p.window.inner_height,
		p.window.outer_width,
		p.window.outer_height,
		p.screen.device_pixel_ratio,
	)
	defer delete(source)
	run_window_script(t, "profile", source)
}
