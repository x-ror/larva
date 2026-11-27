package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Web Storage is per page (pkg/runtime/js/internal/storage.js: both areas live in the
// module's closure, which the loader instantiates afresh for every page's context).
// No oracle can see this: a Chrome recording is one page. The first page fills both
// areas — and checks it did, so a store that silently failed cannot pass the second
// check — and every later page, on the same pooled VM, must start with both empty.
STORAGE_FILL_SOURCE :: `
localStorage.setItem('k', 'first page');
localStorage.named = 'x';
sessionStorage.setItem('s', 'first page');
if (localStorage.getItem('k') !== 'first page' || localStorage.length !== 2 || sessionStorage.length !== 1)
  throw new Error('the first page did not store');
`

STORAGE_EMPTY_SOURCE :: `
if (localStorage.length !== 0 || sessionStorage.length !== 0)
  throw new Error('a later page sees ' + localStorage.length + ' local, ' + sessionStorage.length + ' session items');
if (localStorage.getItem('k') !== null || 'named' in localStorage || sessionStorage.getItem('s') !== null)
  throw new Error('a later page reads the first page\'s items');
`

@(test)
storage_is_per_page :: proc(t: ^testing.T) {
	run :: proc(t: ^testing.T, source: string, what: string) {
		loop := eventloop.init()
		// eval consumes (destroys) the loop on every path.
		result := lava.eval(source, "<storage-isolation-test>", &loop, false)
		defer lava.result_destroy(&result)
		testing.expectf(t, result.status == .Ok, "%s: status=%v message=%q", what, result.status, result.message)
	}

	run(t, STORAGE_FILL_SOURCE, "first page")
	_, created_before, _ := lava.vm_pool_stats(lava.thread_vm_pool())
	for _ in 0 ..< 3 {
		run(t, STORAGE_EMPTY_SOURCE, "later page")
		run(t, STORAGE_FILL_SOURCE, "refilling page")
	}
	// The VM was reused, so the isolation above is between contexts, not between VMs.
	_, created_after, _ := lava.vm_pool_stats(lava.thread_vm_pool())
	testing.expect_value(t, created_after, created_before)
}
