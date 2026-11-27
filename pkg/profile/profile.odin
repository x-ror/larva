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
	screen:               Screen_Geometry,
	window:               Window_Geometry,
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
}

// default_profile returns the profile a page gets when the caller names none. Read-only:
// the table is static data shared by every page and thread.
default_profile :: proc "contextless" () -> ^Client_Profile {
	return &CHROME_158_LINUX
}
