#+build linux, darwin
package main

import "core:fmt"
import "core:os"
import "core:strings"
import "core:testing"
import http "lava:pkg/http"
import profile "lava:pkg/profile"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

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
	// A loop, or the timers never run: run_file without one stops after the top level.
	// run_file consumes (destroys) it on every path.
	loop := eventloop.init()
	result := lava.run_file(path, &loop, origin = origin)
	defer lava.result_destroy(&result)
	// A throw from a timer leaves the status Ok and is reported as exit code 1 at close.
	testing.expectf(
		t,
		result.status == .Ok && result.exit_code == 0,
		"%s: status=%v exit_code=%d message=%q",
		name,
		result.status,
		result.exit_code,
		result.message,
	)
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
location.assign('/other#f'); expect('assign with a fragment');
location.href = 'http://elsewhere.test/page#x'; expect('href with a fragment');
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

// userAgentData, connection, the PDF plugins and the storage quota are the profile's
// (pkg/profile UA_Data, Network_Information): a recording can only show their types and
// relations (tests/web/cases/navigator-apis), since Chrome reports its own machine's.
@(test)
window_env_reports_the_profile_client_hints :: proc(t: ^testing.T) {
	// Braces doubled: core:fmt reads `{` as the start of an argument index. The async
	// checks throw from a timer, which run_file reports.
	CHECK :: `const fail = (what, got) => {{ throw new Error(what + ' ' + JSON.stringify(got)); }};
const u = navigator.userAgentData;
if (JSON.stringify(u.brands) !== %q) fail('brands', u.brands);
if (u.mobile !== %v || u.platform !== %q) fail('low entropy', u);
const c = navigator.connection;
if (c.effectiveType !== %q || c.rtt !== %d || c.downlink !== %v || c.saveData !== %v) {{
  fail('connection', [c.effectiveType, c.rtt, c.downlink, c.saveData]);
}}
if (navigator.pdfViewerEnabled !== %v || navigator.plugins.length !== %d) fail('pdf', navigator.plugins.length);
if (navigator.cpuPerformance !== %d) fail('cpuPerformance', navigator.cpuPerformance);
const hints = ['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'wow64', 'fullVersionList'];
u.getHighEntropyValues(hints).then((v) => setTimeout(() => {{
  const got = JSON.stringify([v.architecture, v.bitness, v.model, v.platformVersion, v.uaFullVersion, v.wow64]);
  if (got !== JSON.stringify([%q, %q, %q, %q, %q, %v])) fail('high entropy', got);
  if (JSON.stringify(v.fullVersionList) !== %q) fail('fullVersionList', v.fullVersionList);
}}, 0));
navigator.storage.estimate().then((e) => setTimeout(() => {{
  if (e.quota !== %v || e.usage !== 0) fail('estimate', e);
}}, 0));
`


	p := profile.default_profile()
	ua := &p.ua_data
	brands := brand_list_json(ua.brands, false)
	defer delete(brands)
	full := brand_list_json(ua.brands, true)
	defer delete(full)
	source := fmt.aprintf(
		CHECK,
		brands,
		ua.mobile,
		ua.platform,
		p.connection.effective_type,
		p.connection.rtt,
		p.connection.downlink,
		p.connection.save_data,
		p.pdf_viewer_enabled,
		p.pdf_viewer_enabled ? 5 : 0,
		p.cpu_performance,
		ua.architecture,
		ua.bitness,
		ua.model,
		ua.platform_version,
		ua.full_version,
		ua.wow64,
		full,
		p.storage_quota,
	)
	defer delete(source)
	run_window_script(t, "client-hints", source)
}

// The JSON of a NavigatorUABrandVersion list, as JSON.stringify writes it.
@(private = "file")
brand_list_json :: proc(brands: []profile.UA_Brand, full: bool) -> string {
	b := strings.builder_make()
	strings.write_byte(&b, '[')

	for brand, i in brands {
		if i > 0 {
			strings.write_byte(&b, ',')
		}

		fmt.sbprintf(&b, `{{"brand":%q,"version":%q}}`, brand.brand, full ? brand.full_version : brand.version)
	}

	strings.write_byte(&b, ']')
	return strings.to_string(b)
}
