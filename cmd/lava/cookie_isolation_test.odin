package main

import "core:strings"
import "core:testing"
import lava "lava:pkg/runtime"

// The cookie jar is per page until sessions exist (pkg/runtime/cookie.odin: the
// Runtime_State's own jar, made and destroyed with it). No oracle can see this: a Chrome
// recording is one page. The first page stores a cookie and reads it back, so a store
// that silently failed cannot pass the later check; every later page on the same
// pooled VM, at the same origin, must start with an empty jar.
@(private = "file")
COOKIE_FILL_PAGE :: `<pre id=out></pre><script>
document.cookie = 'k=first page; Max-Age=3600';
document.getElementById('out').textContent = 'saw[' + document.cookie + ']';
</script>`

@(private = "file")
COOKIE_READ_PAGE :: `<pre id=out></pre><script>
document.getElementById('out').textContent = 'saw[' + document.cookie + ']';
</script>`

@(test)
cookie_jar_is_per_page :: proc(t: ^testing.T) {
	run :: proc(markup: string) -> string {
		result, output := lava.run_html_page(
			transmute([]byte)markup,
			"<cookie-isolation>",
			origin = "http://example.test/a",
		)
		lava.result_destroy(&result)
		return output
	}

	first := run(COOKIE_FILL_PAGE)
	testing.expectf(t, strings.contains(first, "saw[k=first page]"), "first page: %s", first)
	delete(first)

	_, created_before, _ := lava.vm_pool_stats(lava.thread_vm_pool())
	for _ in 0 ..< 3 {
		later := run(COOKIE_READ_PAGE)
		testing.expectf(t, strings.contains(later, "saw[]"), "a later page sees the first page's cookies: %s", later)
		delete(later)
		refill := run(COOKIE_FILL_PAGE)
		testing.expectf(t, strings.contains(refill, "saw[k=first page]"), "refilling page: %s", refill)
		delete(refill)
	}
	// The VM was reused, so the isolation above is between pages, not between VMs.
	_, created_after, _ := lava.vm_pool_stats(lava.thread_vm_pool())
	testing.expect_value(t, created_after, created_before)
}

// Without an origin (about:blank, opaque) document.cookie reads "" and ignores a write,
// as a top-level about:blank document does in Chrome.
@(test)
an_opaque_document_has_no_cookies :: proc(t: ^testing.T) {
	markup := `<pre id=out></pre><script>
	document.cookie = 'k=1';
	document.getElementById('out').textContent = 'saw[' + document.cookie + ']';
	</script>`
	result, output := lava.run_html_page(transmute([]byte)markup, "<cookie-opaque>")
	lava.result_destroy(&result)
	defer delete(output)
	testing.expectf(t, strings.contains(output, "saw[]"), "%s", output)
}
