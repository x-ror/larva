// The cookie jar both HTTP stacks share: pkg/http's transfers (`lava fetch`) and the
// runtime's fetch(), XMLHttpRequest and document.cookie (pkg/runtime/cookie.odin). It
// parses Set-Cookie as Chrome 158 implements RFC 6265bis, stores what it accepts, and
// answers the Cookie header for a request. No I/O, no JS, no event loop: a jar is plain
// data, touched only by the thread that owns it (a page's loop thread).
//
// Scope. docs/LARVA.md decision 3 gives the jar to a *session*; there is no session
// object yet, so the runtime gives each page its own (Runtime_State.cookie_jar, one page
// being the default session) and `lava fetch` one per run. Nothing here knows who owns a
// jar: a session that outlives its pages will hand the same ^Jar to each, and only the
// owner's choice of lifetime changes.
//
// Chrome's behaviour is the oracle, recorded in tests/dom/cases/cookie-document-*.page
// (document.cookie) and tests/web/cases/cookie-{fetch,xhr} (Set-Cookie and Cookie over
// the wire). Where this file departs from it, each departure says so where it is made;
// the list is in Deviates of set_cookie and cookie_header.
package larva_cookie

import "base:runtime"
import "core:net"
import "core:strings"
import dt "core:time/datetime"

// Chrome's limits (net/cookies/cookie_constants.h, cookie_monster.h). The name+value and
// per-domain numbers are recorded in tests/dom/cases/cookie-document-limits.page: 4096
// bytes of name and value store and 4097 do not; a 181st cookie on one site purges the
// site back to 150.
MAX_NAME_VALUE_BYTES :: 4096
// An attribute whose value is longer is ignored, as if it were not there (the cookie
// still stores): a 1025-byte Path falls back to the default path.
MAX_ATTRIBUTE_VALUE_BYTES :: 1024
DOMAIN_MAX_COOKIES :: 180
DOMAIN_PURGE_TO :: 150
TOTAL_MAX_COOKIES :: 3300
TOTAL_PURGE_TO :: 3000
// Expires and Max-Age are capped 400 days out (RFC 6265bis §5.5).
MAX_EXPIRY_SECONDS :: 400 * 24 * 60 * 60
// A cookie's last-access time moves only when it is this stale, as Chrome's
// kLastAccessThreshold does: reading every cookie on every request would otherwise turn
// each Cookie header into a write per cookie.
LAST_ACCESS_THRESHOLD_NS :: i64(60) * 1_000_000_000

@(private)
NS_PER_SECOND :: i64(1_000_000_000)
@(private = "file", rodata)
MONTHS := [12]string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}

Same_Site :: enum u8 {
	Unspecified, // no attribute, or a value Chrome does not know: enforced as Lax
	None,
	Lax,
	Strict,
}

// Site_Context is how the request relates to the site that makes it. Every caller today
// knows only two answers: a page's own fetch is same-site or cross-site with the page,
// and a navigation typed by the user (`lava fetch`) is same-site with itself.
Site_Context :: enum u8 {
	Cross_Site,
	// A cross-site top-level GET navigation: Lax cookies go, Strict ones do not. Nothing
	// produces it yet (there is no navigation from a page); kept so the rule has a home.
	Lax_Navigation,
	Same_Site,
}

// Source is the URL a cookie is set from or sent to, already parsed by the caller: the
// two stacks have different URL parsers and neither belongs here.
Source :: struct {
	// https://, or a host Chrome counts as potentially trustworthy over http
	// (is_potentially_trustworthy): those may set and receive Secure cookies.
	secure: bool,
	// Lowercase ASCII (an IDN already in punycode); an IPv6 literal with or without its
	// brackets.
	host:   string,
	// The URL's path, from its first '/', without the query; "" counts as "/".
	path:   string,
}

// Access says who is asking: the HTTP stack (Set-Cookie, Cookie) sees HttpOnly cookies,
// a script (document.cookie) does not and may not set them.
Access :: enum u8 {
	Http,
	Script,
}

Cookie :: struct {
	name:        string,
	value:       string,
	// Without a leading dot. A host-only cookie matches this host exactly; a domain
	// cookie also matches its subdomains.
	domain:      string,
	path:        string,
	// Unix seconds; meaningful only for a persistent cookie.
	expires:     i64,
	// Creation order (a counter, so two cookies set in one nanosecond still order) and the
	// last access in Unix nanoseconds, for the Cookie header's order and for eviction.
	creation:    i64,
	last_access: i64,
	persistent:  bool,
	host_only:   bool,
	secure:      bool,
	http_only:   bool,
	same_site:   Same_Site,
}

// Jar owns every string of every cookie in it, through the allocator it captured at
// jar_init (CLAUDE.md §4: the runtime sets cookies from `proc "c"` natives, whose
// ambient allocator is not the page's).
Jar :: struct {
	allocator: runtime.Allocator,
	cookies:   [dynamic]Cookie,
	next_id:   i64,
}

// Status is set_cookie's verdict. Every refusal leaves the jar as it was.
Status :: enum u8 {
	Stored,
	// The cookie was already expired: it removed its equivalent, if there was one.
	Deleted,
	// A control character, or an empty name and value (RFC 6265bis §5.6 steps 1-3).
	Invalid,
	Too_Large, // name and value over MAX_NAME_VALUE_BYTES
	// Domain= that the host does not domain-match, or a public suffix (see
	// domain_attribute for the MVP rule).
	Bad_Domain,
	Insecure, // Secure from an insecure source
	Prefix, // a __Secure- or __Host- name (or nameless value) without what it requires
	Http_Only, // HttpOnly from a script, or a script overwriting an HttpOnly cookie
	Same_Site_None_Insecure, // SameSite=None without Secure
	Same_Site_Context, // a Lax/Strict/unspecified cookie set from a cross-site request
	// An insecure source would overwrite or shadow a Secure cookie (RFC 6265bis §5.7
	// step 14's "strict secure cookies").
	Shadows_Secure,
}

jar_init :: proc(jar: ^Jar, allocator := context.allocator) {
	jar^ = {
		allocator = allocator,
		cookies   = make([dynamic]Cookie, allocator),
	}
}

jar_destroy :: proc(jar: ^Jar) {
	for &c in jar.cookies {
		cookie_free(jar, &c)
	}

	delete(jar.cookies)
	jar^ = {}
}

// jar_clear empties the jar and keeps its backing, for a session that starts over.
jar_clear :: proc(jar: ^Jar) {
	for &c in jar.cookies {
		cookie_free(jar, &c)
	}

	clear(&jar.cookies)
}

// set_cookie parses one Set-Cookie value (or one document.cookie assignment) received
// from `url` and stores, replaces or deletes the cookie it describes.
//
// Params:
//   now_ns  Unix nanoseconds: expiry and creation are computed against it, so a test
//           passes a fixed clock.
//   site    The request's relation to the site that made it (Site_Context).
// Returns:
//   Stored or Deleted when the jar changed as the line asked, otherwise why the line
//   was refused.
// Node:
//   Chrome 158, tests/dom/cases/cookie-document-{basic,attributes,limits}.page and
//   tests/web/cases/cookie-{fetch,xhr}: what follows is what those recordings showed.
//   Any control character in the line refuses the whole line, HTAB inside a name or
//   value included; a nameless line ("x", or "=x") sets the empty-named cookie, "=" and
//   "" set nothing; Max-Age wins over Expires wherever it stands and takes a leading '+'
//   ("+0" deletes); an Expires year before 1601 clamps to 1601 (and so deletes); a
//   replaced cookie keeps its creation time, and so its place in the header, only when
//   its value is unchanged; Secure is accepted from http://127.0.0.1; the __Secure- and
//   __Host- prefixes match case-insensitively; SameSite=None without Secure is refused.
// Deviates:
//   No public suffix list (docs/LARVA.md stage 2 embeds one): Domain= naming a single
//   label is treated as a public suffix, so `Domain=co.uk` is accepted where Chrome
//   refuses it. Eviction purges by last access only, where Chrome first spends
//   non-secure, then low-priority cookies, and keys a site by its registrable domain,
//   which without the list is approximated by the last two labels (site_key). A
//   non-ASCII Domain= is refused, where Chrome converts it to punycode. Pinned by
//   pkg/http/cookie/cookie_test.odin.
set_cookie :: proc(jar: ^Jar, url: Source, line: string, access: Access, site: Site_Context, now_ns: i64) -> Status {
	parsed, status := parse(line)

	if status != .Stored {
		return status
	}

	if len(parsed.name) + len(parsed.value) > MAX_NAME_VALUE_BYTES {
		return .Too_Large
	}

	host := strip_brackets(url.host)
	c := Cookie {
		name      = parsed.name,
		value     = parsed.value,
		secure    = parsed.secure,
		http_only = parsed.http_only,
		same_site = parsed.same_site,
	}

	// Domain (RFC 6265bis §5.7 steps 8-11).
	if parsed.has_domain {
		domain, host_only, ok := domain_attribute(parsed.domain, host)

		if !ok {
			return .Bad_Domain
		}

		c.domain, c.host_only = domain, host_only
	} else {
		c.domain, c.host_only = host, true
	}

	c.path = parsed.path if parsed.has_path else default_path(url.path)

	if c.secure && !url.secure {
		return .Insecure
	}

	if !prefix_ok(parsed, url.secure) {
		return .Prefix
	}

	if c.http_only && access == .Script {
		return .Http_Only
	}

	if c.same_site == .None && !c.secure {
		return .Same_Site_None_Insecure
	}

	// A cross-site response may set only SameSite=None cookies; unspecified is Lax.
	if site == .Cross_Site && c.same_site != .None {
		return .Same_Site_Context
	}

	now_s := now_ns / NS_PER_SECOND
	expired := false

	if parsed.has_max_age {
		c.persistent = true

		if parsed.max_age <= 0 {
			expired = true
		} else {
			c.expires = now_s + min(parsed.max_age, MAX_EXPIRY_SECONDS)
		}
	} else if parsed.has_expires {
		c.persistent = true

		if parsed.expires <= now_s {
			expired = true
		} else {
			c.expires = min(parsed.expires, now_s + MAX_EXPIRY_SECONDS)
		}
	}

	if !url.secure && !c.secure && shadows_secure(jar, c) {
		return .Shadows_Secure
	}

	old := find_equivalent(jar, c)

	if old >= 0 && jar.cookies[old].http_only && access == .Script {
		return .Http_Only
	}

	inherit_creation := i64(-1)

	if old >= 0 {
		if jar.cookies[old].value == c.value {
			inherit_creation = jar.cookies[old].creation
		}

		cookie_free(jar, &jar.cookies[old])
		ordered_remove(&jar.cookies, old)
	}

	if expired {
		return .Deleted
	}

	context.allocator = jar.allocator
	c.name = strings.clone(c.name)
	c.value = strings.clone(c.value)
	c.domain = strings.clone(c.domain)
	c.path = strings.clone(c.path)

	if inherit_creation >= 0 {
		c.creation = inherit_creation
	} else {
		c.creation = jar.next_id
		jar.next_id += 1
	}

	c.last_access = now_ns
	append(&jar.cookies, c)
	evict(jar, c.domain, now_s)
	return .Stored
}

// cookie_header writes the Cookie header value for a request to `url` into `sb`:
// "name=value" pairs, or a bare value for a nameless cookie, joined by "; ", longer
// paths first, then older cookies first (RFC 6265bis §5.8.3 step 2). Expired cookies
// found on the way are dropped. Returns whether anything was written.
//
// Node:
//   Chrome 158, tests/dom/cases/cookie-document-attributes.page (path and domain match,
//   the order) and tests/web/cases/cookie-fetch (Secure from 127.0.0.1, HttpOnly sent
//   over HTTP).
// Deviates:
//   Last access moves at most once a minute (LAST_ACCESS_THRESHOLD_NS), as Chrome; the
//   threshold is Chrome's, the purge order it feeds is not (see set_cookie).
cookie_header :: proc(
	jar: ^Jar,
	url: Source,
	access: Access,
	site: Site_Context,
	now_ns: i64,
	sb: ^strings.Builder,
) -> bool {
	host := strip_brackets(url.host)
	path := url.path if url.path != "" else "/"
	now_s := now_ns / NS_PER_SECOND

	// The matches, as indexes into the jar, sorted in place below: a few dozen at most
	// for a real site, so an insertion sort on a fixed buffer, spilling to the jar's
	// allocator only past it.
	fixed: [64]int
	matches := fixed[:0]
	spill: [dynamic]int
	defer delete(spill)

	i := 0
	for i < len(jar.cookies) {
		c := &jar.cookies[i]

		if c.persistent && c.expires <= now_s {
			cookie_free(jar, c)
			ordered_remove(&jar.cookies, i)
			continue
		}

		i += 1

		if !sendable(c, host, path, url.secure, access, site) {
			continue
		}

		if len(matches) < len(fixed) {
			matches = fixed[:len(matches) + 1]
			matches[len(matches) - 1] = i - 1
			continue
		}

		if spill == nil {
			spill = make([dynamic]int, 0, 2 * len(fixed), jar.allocator)
			append(&spill, ..matches)
		}

		append(&spill, i - 1)
	}

	list := spill[:] if spill != nil else matches

	for a in 1 ..< len(list) {
		for b := a; b > 0 && sends_before(&jar.cookies[list[b]], &jar.cookies[list[b - 1]]); b -= 1 {
			list[b], list[b - 1] = list[b - 1], list[b]
		}
	}

	for idx, n in list {
		c := &jar.cookies[idx]

		if n > 0 {
			strings.write_string(sb, "; ")
		}

		if c.name != "" {
			strings.write_string(sb, c.name)
			strings.write_byte(sb, '=')
		}

		strings.write_string(sb, c.value)

		if now_ns - c.last_access >= LAST_ACCESS_THRESHOLD_NS {
			c.last_access = now_ns
		}
	}

	return len(list) > 0
}

// is_potentially_trustworthy says whether a URL with this scheme and host may set and
// receive Secure cookies: https, or http to a loopback host (localhost, *.localhost,
// 127.0.0.0/8, ::1), which Chrome counts as a secure context.
//
// Node:
//   Chrome 158, tests/dom/cases/cookie-document-attributes.page: `s1=1; Secure` set from
//   http://127.0.0.1 is stored and read back.
is_potentially_trustworthy :: proc(https: bool, host: string) -> bool {
	if https {
		return true
	}

	h := strip_brackets(host)

	if ascii_equal_fold(h, "localhost") || ascii_has_suffix_fold(h, ".localhost") {
		return true
	}

	if ip4, ok := net.parse_ip4_address(h); ok {
		return ip4[0] == 127
	}

	if ip6, ok := net.parse_ip6_address(h); ok {
		return ip6 == net.IP6_Loopback
	}

	return false
}

// same_site says whether two URLs are schemefully same-site: the same scheme family
// (secure or not) and the same site key. An empty host on either side is an opaque
// origin, same-site with nothing.
same_site :: proc(a_https: bool, a_host: string, b_https: bool, b_host: string) -> bool {
	if a_host == "" || b_host == "" || a_https != b_https {
		return false
	}

	return ascii_equal_fold(site_key(strip_brackets(a_host)), site_key(strip_brackets(b_host)))
}

// site_key stands in for a host's registrable domain (eTLD+1): the host itself for an IP
// literal or a single label, else its last two labels. Without a public suffix list
// `a.co.uk` and `b.co.uk` share a key, where Chrome gives each its own; see set_cookie's
// Deviates.
site_key :: proc(host: string) -> string {
	if is_ip(host) {
		return host
	}

	h := strings.trim_right(host, ".")
	last := strings.last_index_byte(h, '.')

	if last < 0 {
		return h
	}

	prev := strings.last_index_byte(h[:last], '.')
	return h[prev + 1:]
}

// --- parsing -------------------------------------------------------------------------

@(private)
Parsed :: struct {
	name, value: string,
	domain:      string,
	path:        string,
	expires:     i64, // Unix seconds
	max_age:     i64,
	same_site:   Same_Site,
	has_domain:  bool,
	has_path:    bool,
	has_expires: bool,
	has_max_age: bool,
	secure:      bool,
	http_only:   bool,
}

// parse splits a set-cookie-string into its name, value and the attributes Chrome acts
// on (RFC 6265bis §5.6). Views into `line`; `status` is .Stored when it parsed.
@(private)
parse :: proc(line: string) -> (p: Parsed, status: Status) {
	for i in 0 ..< len(line) {
		b := line[i]

		if (b < 0x20 && b != '\t') || b == 0x7F {
			return {}, .Invalid
		}
	}

	pair := line
	rest := ""

	if semi := strings.index_byte(line, ';'); semi >= 0 {
		pair, rest = line[:semi], line[semi + 1:]
	}

	if eq := strings.index_byte(pair, '='); eq >= 0 {
		p.name, p.value = trim_wsp(pair[:eq]), trim_wsp(pair[eq + 1:])
	} else {
		p.value = trim_wsp(pair)
	}

	if p.name == "" && p.value == "" {
		return {}, .Invalid
	}

	// Recorded: a tab inside a name or value refuses the cookie, though RFC 6265bis lets
	// HTAB through; around them it is whitespace and trimmed.
	if strings.index_byte(p.name, '\t') >= 0 || strings.index_byte(p.value, '\t') >= 0 {
		return {}, .Invalid
	}

	for rest != "" {
		av := rest
		rest = ""

		if semi := strings.index_byte(av, ';'); semi >= 0 {
			av, rest = av[:semi], av[semi + 1:]
		}

		key, val := av, ""

		if eq := strings.index_byte(av, '='); eq >= 0 {
			key, val = av[:eq], av[eq + 1:]
		}

		key, val = trim_wsp(key), trim_wsp(val)

		if len(val) > MAX_ATTRIBUTE_VALUE_BYTES {
			continue
		}

		switch {
		case ascii_equal_fold(key, "expires"):
			if t, ok := parse_cookie_date(val); ok {
				p.expires, p.has_expires = t, true
			}
		case ascii_equal_fold(key, "max-age"):
			if n, ok := parse_max_age(val); ok {
				p.max_age, p.has_max_age = n, true
			}
		case ascii_equal_fold(key, "domain"):
			// An empty Domain= is ignored: the cookie stays host-only (recorded).
			if val != "" {
				p.domain, p.has_domain = val, true
			}
		case ascii_equal_fold(key, "path"):
			// A Path that is empty or does not start with '/' means the default path.
			if val != "" && val[0] == '/' {
				p.path, p.has_path = val, true
			} else {
				p.path, p.has_path = "", false
			}
		case ascii_equal_fold(key, "secure"):
			p.secure = true
		case ascii_equal_fold(key, "httponly"):
			p.http_only = true
		case ascii_equal_fold(key, "samesite"):
			switch {
			case ascii_equal_fold(val, "none"):
				p.same_site = .None
			case ascii_equal_fold(val, "lax"):
				p.same_site = .Lax
			case ascii_equal_fold(val, "strict"):
				p.same_site = .Strict
			case:
				p.same_site = .Unspecified
			}
		}
	}

	return p, .Stored
}

// parse_max_age reads Max-Age as Chrome's base::StringToInt64 does: an optional sign
// ('+' included, recorded) and digits, nothing else; an overflow saturates.
@(private)
parse_max_age :: proc(s: string) -> (n: i64, ok: bool) {
	digits := s
	negative := false

	if digits != "" && (digits[0] == '+' || digits[0] == '-') {
		negative = digits[0] == '-'
		digits = digits[1:]
	}

	if digits == "" {
		return 0, false
	}

	for b in transmute([]byte)digits {
		if b < '0' || b > '9' {
			return 0, false
		}

		d := i64(b - '0')

		if n > (max(i64) - d) / 10 {
			n = max(i64)
			continue
		}

		n = n * 10 + d
	}

	return -n if negative else n, true
}

// parse_cookie_date is RFC 6265bis §5.4.1, returning Unix seconds. The one change is
// Chrome's: a year outside 1601..30827 is clamped into it rather than failing, so an
// Expires in 1600 still deletes (recorded).
@(private)
parse_cookie_date :: proc(s: string) -> (unix: i64, ok: bool) {
	found_time, found_day, found_month, found_year := false, false, false, false
	hour, minute, second, day, month, year: int

	rest := s
	for rest != "" {
		// Skip delimiters, then take one token.
		start := 0
		for start < len(rest) && is_date_delimiter(rest[start]) {
			start += 1
		}

		end := start
		for end < len(rest) && !is_date_delimiter(rest[end]) {
			end += 1
		}

		token := rest[start:end]
		rest = rest[end:]

		if token == "" {
			continue
		}

		if !found_time {
			if h, m, sec, is_time := parse_time_token(token); is_time {
				hour, minute, second, found_time = h, m, sec, true
				continue
			}
		}

		if !found_day {
			if n, digits := leading_digits(token, 1, 2); digits > 0 {
				day, found_day = n, true
				continue
			}
		}

		if !found_month && len(token) >= 3 {
			if m := month_index(token[:3]); m > 0 {
				month, found_month = m, true
				continue
			}
		}

		if !found_year {
			if n, digits := leading_digits(token, 2, 4); digits > 0 {
				year, found_year = n, true
				continue
			}
		}
	}

	if !(found_time && found_day && found_month && found_year) {
		return 0, false
	}

	if 70 <= year && year <= 99 {
		year += 1900
	} else if 0 <= year && year <= 69 {
		year += 2000
	}

	year = clamp(year, 1601, 30827)

	if day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59 {
		return 0, false
	}

	ordinal, err := dt.components_to_ordinal(year, month, day)

	if err != .None {
		return 0, false
	}

	epoch, _ := dt.components_to_ordinal(1970, 1, 1)
	return (ordinal - epoch) * 86400 + i64(hour) * 3600 + i64(minute) * 60 + i64(second), true
}

// --- matching and storage ------------------------------------------------------------

// domain_attribute applies a Domain= value for a cookie from `host`.
//
// Returns the cookie's domain and whether it is host-only; ok false refuses the cookie.
// A leading dot is dropped and the value lowercased. For an IP host the value must name
// that IP, and the cookie stays host-only (recorded: `Domain=127.0.0.1` and
// `Domain=.127.0.0.1` store, `Domain=0.0.1` does not). Public suffixes: without the
// list, a single label stands in for one (`com`, `localhost`) — refused unless it is the
// host itself, which RFC 6265bis §5.7 step 9 turns into a host-only cookie.
@(private)
domain_attribute :: proc(value, host: string) -> (domain: string, host_only: bool, ok: bool) {
	d := value

	if d[0] == '.' {
		d = d[1:]
	}

	if d == "" {
		return "", false, false
	}

	for b in transmute([]byte)d {
		if b >= 0x80 {
			return "", false, false
		}
	}

	d = strip_brackets(d)

	if is_ip(host) {
		return host, true, ascii_equal_fold(d, host)
	}

	if strings.index_byte(d, '.') < 0 {
		return host, true, ascii_equal_fold(d, host)
	}

	if !domain_matches(host, d) {
		return "", false, false
	}

	// The host's own spelling of the matched suffix: already lowercase.
	return host[len(host) - len(d):], false, true
}

// domain_matches is RFC 6265bis §5.1.3 for a non-IP host: equal ignoring case, or a
// subdomain of `domain` at a label boundary.
@(private)
domain_matches :: proc(host, domain: string) -> bool {
	if ascii_equal_fold(host, domain) {
		return true
	}

	return(
		len(host) > len(domain) &&
		host[len(host) - len(domain) - 1] == '.' &&
		ascii_equal_fold(host[len(host) - len(domain):], domain) &&
		!is_ip(host) \
	)
}

// path_matches is RFC 6265bis §5.1.4: the same path, or `cookie_path` a prefix of
// `request_path` ending at a '/' (its own last byte, or the next one in the request).
@(private)
path_matches :: proc(request_path, cookie_path: string) -> bool {
	if !strings.has_prefix(request_path, cookie_path) {
		return false
	}

	if len(request_path) == len(cookie_path) {
		return true
	}

	return cookie_path[len(cookie_path) - 1] == '/' || request_path[len(cookie_path)] == '/'
}

// default_path is RFC 6265bis §5.1.4's default-path of a request path: up to, not
// including, its last '/', or "/" when that would leave nothing.
@(private)
default_path :: proc(path: string) -> string {
	if path == "" || path[0] != '/' {
		return "/"
	}

	last := strings.last_index_byte(path, '/')
	return "/" if last == 0 else path[:last]
}

@(private)
sendable :: proc(c: ^Cookie, host, path: string, secure: bool, access: Access, site: Site_Context) -> bool {
	if c.host_only {
		if !ascii_equal_fold(host, c.domain) {
			return false
		}
	} else if !domain_matches(host, c.domain) {
		return false
	}

	if !path_matches(path, c.path) {
		return false
	}

	if c.secure && !secure {
		return false
	}

	if c.http_only && access == .Script {
		return false
	}

	switch site {
	case .Same_Site:
		return true
	case .Lax_Navigation:
		return c.same_site != .Strict
	case .Cross_Site:
		return c.same_site == .None
	}

	return false
}

// sends_before orders the Cookie header: the longer path first, then the older cookie.
@(private)
sends_before :: proc(a, b: ^Cookie) -> bool {
	if len(a.path) != len(b.path) {
		return len(a.path) > len(b.path)
	}

	return a.creation < b.creation
}

// prefix_ok checks the cookie name prefixes (RFC 6265bis §4.1.3), case-insensitively as
// Chrome 158 does; a nameless cookie whose value carries one is refused outright.
@(private)
prefix_ok :: proc(p: Parsed, secure_source: bool) -> bool {
	if p.name == "" {
		return !ascii_has_prefix_fold(p.value, "__Secure-") && !ascii_has_prefix_fold(p.value, "__Host-")
	}

	if ascii_has_prefix_fold(p.name, "__Secure-") {
		return p.secure && secure_source
	}

	if ascii_has_prefix_fold(p.name, "__Host-") {
		return p.secure && secure_source && !p.has_domain && p.has_path && p.path == "/"
	}

	return true
}

// find_equivalent returns the index of the stored cookie `c` would replace: the same
// name, domain (host-only and domain cookies apart, as Chrome keys them) and path.
@(private)
find_equivalent :: proc(jar: ^Jar, c: Cookie) -> int {
	for &o, i in jar.cookies {
		if o.name == c.name && o.host_only == c.host_only && ascii_equal_fold(o.domain, c.domain) && o.path == c.path {
			return i
		}
	}

	return -1
}

// shadows_secure is RFC 6265bis §5.7 step 14: from an insecure source, a non-Secure
// cookie may not replace or shadow a Secure one of the same name whose domain matches
// either way and whose path the new one's path-matches.
@(private)
shadows_secure :: proc(jar: ^Jar, c: Cookie) -> bool {
	for &o in jar.cookies {
		if !o.secure || o.name != c.name {
			continue
		}

		if (domain_matches(o.domain, c.domain) || domain_matches(c.domain, o.domain)) && path_matches(c.path, o.path) {
			return true
		}
	}

	return false
}

// evict keeps the site of `domain` at DOMAIN_MAX_COOKIES and the jar at
// TOTAL_MAX_COOKIES: over either, expired cookies go first, then the least recently
// accessed (the older on a tie) until the purge target. Recorded: the 181st cookie on a
// site leaves 150, the oldest ones gone.
@(private)
evict :: proc(jar: ^Jar, domain: string, now_s: i64) {
	key := site_key(domain)
	n := 0
	for &c in jar.cookies {
		if ascii_equal_fold(site_key(c.domain), key) {
			n += 1
		}
	}

	if n > DOMAIN_MAX_COOKIES {
		purge(jar, key, n - DOMAIN_PURGE_TO, now_s)
	}

	if len(jar.cookies) > TOTAL_MAX_COOKIES {
		purge(jar, "", len(jar.cookies) - TOTAL_PURGE_TO, now_s)
	}
}

// purge removes `count` cookies of the site `key` ("" for any site): expired ones first,
// then by last access and creation.
@(private)
purge :: proc(jar: ^Jar, key: string, count: int, now_s: i64) {
	count := count
	in_scope :: proc(c: ^Cookie, key: string) -> bool {
		return key == "" || ascii_equal_fold(site_key(c.domain), key)
	}

	for i := 0; i < len(jar.cookies) && count > 0; {
		c := &jar.cookies[i]

		if in_scope(c, key) && c.persistent && c.expires <= now_s {
			cookie_free(jar, c)
			ordered_remove(&jar.cookies, i)
			count -= 1
			continue
		}

		i += 1
	}

	for count > 0 {
		victim := -1
		for &c, i in jar.cookies {
			if !in_scope(&c, key) {
				continue
			}

			if victim < 0 || evicts_before(&c, &jar.cookies[victim]) {
				victim = i
			}
		}

		if victim < 0 {
			return
		}

		cookie_free(jar, &jar.cookies[victim])
		ordered_remove(&jar.cookies, victim)
		count -= 1
	}
}

@(private)
evicts_before :: proc(a, b: ^Cookie) -> bool {
	if a.last_access != b.last_access {
		return a.last_access < b.last_access
	}

	return a.creation < b.creation
}

@(private)
cookie_free :: proc(jar: ^Jar, c: ^Cookie) {
	delete(c.name, jar.allocator)
	delete(c.value, jar.allocator)
	delete(c.domain, jar.allocator)
	delete(c.path, jar.allocator)
	c^ = {}
}

// --- bytes ---------------------------------------------------------------------------

// is_date_delimiter is RFC 6265bis §5.4.1's delimiter set.
@(private = "file")
is_date_delimiter :: proc(b: byte) -> bool {
	return(
		b == 0x09 ||
		(0x20 <= b && b <= 0x2F) ||
		(0x3B <= b && b <= 0x40) ||
		(0x5B <= b && b <= 0x60) ||
		(0x7B <= b && b <= 0x7E) \
	)
}

// leading_digits reads `min_n` to `max_n` digits at the start of `token` that are not
// followed by another digit (RFC 6265bis's `1*2DIGIT ( non-digit *OCTET )` shapes).
// Returns how many digits were read, 0 when the shape does not match.
@(private = "file")
leading_digits :: proc(token: string, min_n, max_n: int) -> (value: int, digits: int) {
	for digits < len(token) && digits <= max_n && '0' <= token[digits] && token[digits] <= '9' {
		value = value * 10 + int(token[digits] - '0')
		digits += 1
	}

	if digits < min_n || digits > max_n {
		return 0, 0
	}

	return value, digits
}

// parse_time_token reads hms-time: `1*2DIGIT ":" 1*2DIGIT ":" 1*2DIGIT ( non-digit
// *OCTET )`.
@(private = "file")
parse_time_token :: proc(token: string) -> (h, m, s: int, ok: bool) {
	rest := token
	parts: [3]int
	for i in 0 ..< 3 {
		value, digits := leading_digits(rest, 1, 2)

		if digits == 0 {
			return 0, 0, 0, false
		}

		parts[i] = value
		rest = rest[digits:]

		if i < 2 {
			if rest == "" || rest[0] != ':' {
				return 0, 0, 0, false
			}

			rest = rest[1:]
		}
	}

	return parts[0], parts[1], parts[2], true
}

@(private = "file")
month_index :: proc(s: string) -> int {
	for m, i in MONTHS {
		if ascii_equal_fold(s, m) {
			return i + 1
		}
	}

	return 0
}

// trim_wsp drops RFC 6265bis's WSP (space and tab) from both ends.
@(private = "file")
trim_wsp :: proc(s: string) -> string {
	lo, hi := 0, len(s)
	for lo < hi && (s[lo] == ' ' || s[lo] == '\t') {
		lo += 1
	}

	for hi > lo && (s[hi - 1] == ' ' || s[hi - 1] == '\t') {
		hi -= 1
	}

	return s[lo:hi]
}

@(private = "file")
strip_brackets :: proc(host: string) -> string {
	if len(host) >= 2 && host[0] == '[' && host[len(host) - 1] == ']' {
		return host[1:len(host) - 1]
	}

	return host
}

@(private = "file")
is_ip :: proc(host: string) -> bool {
	return net.parse_address(strip_brackets(host)) != nil
}

// ASCII-only folding: core:strings.equal_fold folds Unicode too, so `ſ` would pass for
// `s` in an attribute name (as pkg/http's ascii_equal_fold notes for header names).
@(private = "file")
ascii_equal_fold :: proc(a, b: string) -> bool {
	if len(a) != len(b) {
		return false
	}

	for i in 0 ..< len(a) {
		if ascii_lower(a[i]) != ascii_lower(b[i]) {
			return false
		}
	}

	return true
}

@(private = "file")
ascii_has_prefix_fold :: proc(s, prefix: string) -> bool {
	return len(s) >= len(prefix) && ascii_equal_fold(s[:len(prefix)], prefix)
}

@(private = "file")
ascii_has_suffix_fold :: proc(s, suffix: string) -> bool {
	return len(s) >= len(suffix) && ascii_equal_fold(s[len(s) - len(suffix):], suffix)
}

@(private = "file")
ascii_lower :: proc(b: byte) -> byte {
	return b + ('a' - 'A') if 'A' <= b && b <= 'Z' else b
}
