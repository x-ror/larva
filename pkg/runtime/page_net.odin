package lava_runtime

import "core:time"

// Per-page network activity, for a network-idle wait (page_crawl.odin, #13): every
// request the page makes over the network brackets itself with page_net_begin and
// page_net_end, and the state keeps how many are in flight and when one last began or
// ended. fetch() and XMLHttpRequest — which rides fetch's transport — do so through
// fetch_track_active/fetch_untrack_active (fetch.odin), so a request counts from the
// moment it is issued until it settles: its body read to the end, an error, or an abort.
// A loader of another kind (an external `<script src>` fetched over the network) calls
// the pair itself, once each, on the page's thread.

// page_net_begin records a network request the page started.
page_net_begin :: proc(state: ^Runtime_State) {
	if state == nil {
		return
	}

	state.net_inflight += 1
	state.net_last_activity = time.tick_now()
}

// page_net_end records that a request page_net_begin counted has ended, however it did.
page_net_end :: proc(state: ^Runtime_State) {
	if state == nil {
		return
	}

	// Never below zero: an end without its begin is a caller's bug, and a negative count
	// would read as idle forever after.
	state.net_inflight = max(state.net_inflight - 1, 0)
	state.net_last_activity = time.tick_now()
}
