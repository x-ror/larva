// Package larva_profile is "which browser we are" (#8, docs/LARVA.md decision 3): one
// table per client profile, read by every layer that shows a page or a server what the
// client is — the HTTP User-Agent pkg/http sends, and the values a page reads off
// `navigator`, `screen` and the window's geometry (pkg/runtime/window_env.odin). One
// table, so the two can never disagree: a fingerprinting script compares
// navigator.userAgent with the header, and navigator.platform with both.
//
// A leaf package: it imports nothing, so pkg/http (no JS) and pkg/runtime can both
// depend on it without either depending on the other.
//
// Only the desktop Linux Chrome 158 profile exists, and it is the default. Issue #8 adds
// the rest (TLS ClientHello, H2 SETTINGS, header sets per destination, Client Hints,
// macOS/Windows/Android profiles); this table is where those fields go.
package larva_profile

// The User-Agent is a constant as well as a field: pkg/http's default header table is
// static data, and a static initializer can only name a constant.
CHROME_158_LINUX_USER_AGENT ::
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36"
// The default profile's User-Agent, for the same reason.
DEFAULT_USER_AGENT :: CHROME_158_LINUX_USER_AGENT

// What `navigator`, `screen` and the window geometry report. Values are those of a
// plausible desktop, not of the machine Larva runs on: a page that reads
// hardwareConcurrency or the screen size must see the profile's answer on every host,
// or the same profile would fingerprint differently per server.
Client_Profile :: struct {
	name:                 string,
	user_agent:           string,
	// navigator.platform: the UA's platform token, as Chrome reports it.
	platform:             string,
	vendor:               string,
	// navigator.languages, most preferred first; navigator.language is the first.
	languages:            []string,
	hardware_concurrency: int,
	// navigator.deviceMemory, in GiB, already rounded as Chrome rounds it.
	device_memory:        f64,
	max_touch_points:     int,
	// navigator.pdfViewerEnabled. While true, navigator.plugins and mimeTypes list the
	// five PDF viewer entries every Chrome since 94 reports; while false, both are empty.
	pdf_viewer_enabled:   bool,
	// navigator.cpuPerformance: Chrome's coarse CPU tier, 1 (lowest) to 4; 0 is unknown.
	cpu_performance:      int,
	// navigator.storage.estimate().quota and the legacy webkitTemporaryStorage quota, in
	// bytes: Chrome reports a share of the disk, so it is the profile's disk, not ours.
	storage_quota:        f64,
	screen:               Screen_Geometry,
	window:               Window_Geometry,
	ua_data:              UA_Data,
	connection:           Network_Information,
}

// navigator.userAgentData (User-Agent Client Hints). The low-entropy values (brands,
// mobile, platform) are what every page reads; the rest answer getHighEntropyValues.
// They must agree with user_agent: a script checks the Chromium brand's version against
// the UA's major version and `platform` against navigator.platform.
UA_Data :: struct {
	// In Chrome's GREASE order, which is a function of the major version.
	brands:           []UA_Brand,
	mobile:           bool,
	platform:         string,
	platform_version: string,
	architecture:     string,
	bitness:          string,
	model:            string,
	// uaFullVersion: the browser's full version, which the reduced UA string hides.
	full_version:     string,
	wow64:            bool,
	form_factors:     []string,
}

// One brand: `version` is the major version (brands), `full_version` the full one
// (fullVersionList).
UA_Brand :: struct {
	brand:        string,
	version:      string,
	full_version: string,
}

// navigator.connection (Network Information), already rounded as Chrome rounds it: rtt
// to 25 ms, downlink to 25 kbit/s and capped at 10 Mbit/s.
Network_Information :: struct {
	effective_type: string,
	rtt:            int,
	downlink:       f64,
	save_data:      bool,
}

// The display: what `screen` reports. avail* is the area left by the desktop's panels.
Screen_Geometry :: struct {
	width:              int,
	height:             int,
	avail_width:        int,
	avail_height:       int,
	avail_left:         int,
	avail_top:          int,
	color_depth:        int,
	device_pixel_ratio: f64,
}

// The browser window: outer* is its frame, inner* the viewport, screen_x/y its position.
Window_Geometry :: struct {
	inner_width:  int,
	inner_height: int,
	outer_width:  int,
	outer_height: int,
	screen_x:     int,
	screen_y:     int,
}

// A maximized Chrome 158 window on a 1920x1080 Linux desktop with a 40 px bottom panel:
// the viewport is the window less Chrome's tab strip and toolbar (103 px).
@(rodata)
CHROME_158_LINUX := Client_Profile {
	name = "chrome_158_linux",
	user_agent = CHROME_158_LINUX_USER_AGENT,
	platform = "Linux x86_64",
	vendor = "Google Inc.",
	languages = {"en-US", "en"},
	hardware_concurrency = 8,
	device_memory = 8,
	max_touch_points = 0,
	pdf_viewer_enabled = true,
	cpu_performance = 2,
	// 60% of a 512 GB disk, Chrome's share for a non-incognito origin's quota pool.
	storage_quota = 307_200_000_000,
	screen = {
		width = 1920,
		height = 1080,
		avail_width = 1920,
		avail_height = 1040,
		avail_left = 0,
		avail_top = 0,
		color_depth = 24,
		device_pixel_ratio = 1,
	},
	window = {
		inner_width = 1920,
		inner_height = 937,
		outer_width = 1920,
		outer_height = 1040,
		screen_x = 0,
		screen_y = 0,
	},
	// Chrome's GREASE for major 158 (Chromium's GetUserAgentBrandList, seed = major):
	// the brand "Not" + ".A/" + "Brand", version "24", and with three brands the order
	// permutation 158 % 6 = 2 — Chromium, the GREASE brand, Google Chrome. The two-brand
	// headless recording (tests/web/cases/navigator-apis.expected's machine) shows the
	// same GREASE brand and version.
	ua_data = {
		brands = {
			{brand = "Chromium", version = "158", full_version = "158.0.8127.36"},
			{brand = "Not.A/Brand", version = "24", full_version = "24.0.0.0"},
			{brand = "Google Chrome", version = "158", full_version = "158.0.8127.36"},
		},
		mobile = false,
		platform = "Linux",
		platform_version = "",
		architecture = "x86",
		bitness = "64",
		model = "",
		full_version = "158.0.8127.36",
		wow64 = false,
		form_factors = {"Desktop"},
	},
	connection = {effective_type = "4g", rtt = 50, downlink = 10, save_data = false},
}

// default_profile returns the profile a page gets when the caller names none. Read-only:
// the table is static data shared by every page and thread.
default_profile :: proc "contextless" () -> ^Client_Profile {
	return &CHROME_158_LINUX
}
