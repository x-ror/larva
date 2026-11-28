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
	tls:                  TLS_Profile,
}

// The TLS ClientHello (#6): what pkg/tls configures BoringSSL with so a JA3/JA4 capture
// of Larva reads as this browser's. Every value is read off a recorded Chrome
// ClientHello (tests/tls/, recorded by scripts/record-tls-hello.mjs against a local
// echo), not off Chromium's source: pkg/tls/fingerprint_test.odin compares the two.
// Codepoints are IANA's; extension ORDER is not a field because Chrome permutes it.
TLS_Profile :: struct {
	// BoringSSL cipher-rule string for TLS 1.2 suites, applied strictly (an unknown
	// rule fails the context). TLS 1.3 suites are not configurable in BoringSSL and
	// come out in Chrome's order (AES-128-GCM, AES-256-GCM, ChaCha20) already.
	cipher_list:             cstring,
	// supported_groups, most preferred first (GREASE excluded; BoringSSL adds it).
	groups:                  []u16,
	// signature_algorithms, in order (GREASE excluded).
	sigalgs:                 []u16,
	// ALPN protocol list, in wire format (each name length-prefixed).
	alpn:                    []u8,
	// draft-ietf-tls-trust-anchor-ids: the TrustAnchorIDs Chrome requests, wire format
	// without the outer length. Empty sends no extension.
	trust_anchors:           []u8,
	// Bytes of padding requested from the server (BoringSSL's server_padding
	// experiment, extension 4832); -1 sends no extension.
	server_padding_request:  int,
	// RFC 8701 GREASE in ciphers, extensions, groups, versions and sigalgs.
	grease:                  bool,
	// Shuffle the ClientHello extension order per connection, as Chrome >= 110 does.
	permute_extensions:      bool,
	// A GREASE encrypted_client_hello extension when no ECH config is known.
	ech_grease:              bool,
	// RFC 8879 certificate compression with brotli (decompression only).
	cert_compression_brotli: bool,
	// status_request (OCSP stapling) and signed_certificate_timestamp.
	ocsp_stapling:           bool,
	signed_cert_timestamps:  bool,
	// Resume with session tickets / TLS 1.3 PSK from a per-host cache.
	session_resumption:      bool,
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
	// Chrome 158's ClientHello, from tests/tls/chrome-158-linux.clienthello.hex (Chrome for
	// Testing 158.0.8127.36, headless, Linux, at a non-localhost name).
	// ALPN offers http/1.1 only: Larva speaks HTTP/1.1 until H2 (#7), and offering h2 to a
	// server that picks it would break the request. Chrome offers h2,http/1.1 and sends
	// ALPS (17613) for h2; both are deviations in the JA4 (`h1` for `h2`, one extension
	// fewer), and fingerprint_test.odin names them. ECH GREASE is off because the
	// recording carries no encrypted_client_hello extension.
	tls = {
		cipher_list = "ALL:!aPSK:!ECDSA+SHA1:!3DES",
		// X25519MLKEM768, X25519, P-256, P-384.
		groups = {0x11ec, 0x001d, 0x0017, 0x0018},
		sigalgs = {
			0x0904, // mldsa44
			0x0905, // mldsa65
			0x0906, // mldsa87
			0x0403, // ecdsa_secp256r1_sha256
			0x0804, // rsa_pss_rsae_sha256
			0x0401, // rsa_pkcs1_sha256
			0x0503, // ecdsa_secp384r1_sha384
			0x0805, // rsa_pss_rsae_sha384
			0x0501, // rsa_pkcs1_sha384
			0x0806, // rsa_pss_rsae_sha512
			0x0601, // rsa_pkcs1_sha512
		},
		alpn = {8, 'h', 't', 't', 'p', '/', '1', '.', '1'},
		// The Chrome Root Store's trust anchor IDs (relative OIDs), as recorded.
		trust_anchors = {
			0x05, 0x82, 0xdf, 0x13, 0x02, 0x01,
			0x05, 0x82, 0xdf, 0x13, 0x02, 0x06,
			0x05, 0x82, 0xdf, 0x13, 0x02, 0x0d,
			0x05, 0x82, 0xdf, 0x13, 0x02, 0x0e,
			0x05, 0x82, 0xdf, 0x13, 0x02, 0x0f,
			0x05, 0x82, 0xdf, 0x13, 0x02, 0x12,
			0x05, 0x82, 0xdf, 0x13, 0x02, 0x13,
			0x05, 0x82, 0xdf, 0x13, 0x02, 0x14,
			0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x07,
			0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x08,
			0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x09,
			0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x0a,
			0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x0b,
			0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x0c,
			0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x0d,
			0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x12,
			0x08, 0x83, 0x9a, 0x64, 0x8c, 0x9b, 0x2d, 0x01, 0x13,
			0x04, 0xd6, 0x79, 0x09, 0x01,
			0x04, 0xd6, 0x79, 0x09, 0x04,
			0x04, 0xd6, 0x79, 0x09, 0x05,
			0x04, 0xd6, 0x79, 0x09, 0x06,
			0x04, 0xd6, 0x79, 0x09, 0x07,
			0x04, 0xd6, 0x79, 0x09, 0x08,
			0x04, 0xd6, 0x79, 0x09, 0x0a,
			0x04, 0xd6, 0x79, 0x09, 0x0b,
			0x04, 0xd6, 0x79, 0x09, 0x0c,
			0x04, 0xd6, 0x79, 0x09, 0x0d,
			0x04, 0xd6, 0x79, 0x09, 0x0f,
		},
		server_padding_request = 0,
		grease = true,
		permute_extensions = true,
		ech_grease = false,
		cert_compression_brotli = true,
		ocsp_stapling = true,
		signed_cert_timestamps = true,
		session_resumption = true,
	},
}

// default_profile returns the profile a page gets when the caller names none. Read-only:
// the table is static data shared by every page and thread.
default_profile :: proc "contextless" () -> ^Client_Profile {
	return &CHROME_158_LINUX
}
