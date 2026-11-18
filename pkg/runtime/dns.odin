package lava_runtime

import "base:runtime"
import "core:c"
import "core:net"
import "core:strings"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// node:dns bridge — Tier 1 (lookup). js/node/dns.js implements the public
// dns / dns.promises surface on top of these native primitives; the actual name
// resolution is core:net's DNS client (NOT the system getaddrinfo — core:net
// parses /etc/resolv.conf + /etc/hosts and speaks DNS itself), run off the event
// loop on a worker thread so a slow lookup never blocks the loop. This mirrors
// the fetch DNS hand-off (fetch_transport.odin): async_begin keeps the loop
// alive, the worker posts a completion back via post_async, and the completion
// (loop thread) builds the JS result and invokes the user callback.
//
// Because core:net is not getaddrinfo, the getaddrinfo hint flags (ADDRCONFIG,
// V4MAPPED) are validated in dns.js but have no behavioral effect here yet; the
// result `order` (verbatim/ipv4first/ipv6first) IS honored across the per-family
// queries below. The record-type queries (resolve4/resolveMx/…) and reverse/
// lookupService are Tier 2 and live behind c-ares (see pkg/std/cares).

// Result order codes shared with js/node/dns.js (ORDER_CODES). Only the
// IPv6-first case changes which family we try first; verbatim and ipv4first both
// try IPv4 first (core:net has no single interleaved OS order to preserve).
ORDER_VERBATIM :: 0
ORDER_IPV4FIRST :: 1
ORDER_IPV6FIRST :: 2

Dns_Lookup_Result :: struct {
	addr:   net.Address, // IP4_Address | IP6_Address
	family: int, // 4 or 6
}

// Dns_Lookup_Request is heap-allocated by dns_lookup_cb and lives until the
// completion fires (dns_lookup_complete_cb), or until the loop's worker pool is
// torn down and frees it via dns_dispose. The pool worker writes results/ok/
// err_code off-loop; post_async's lock (inside the pool handoff) publishes those
// writes to the loop thread that reads them.
Dns_Lookup_Request :: struct {
	ctx:       jsc.JSContextRef,
	callback:  jsc.JSObjectRef, // GC-protected JS callback(errCode|null, addresses|null)
	// allocator owns `hostname` and the request struct: always the heap, captured at
	// creation rather than read from the ambient context, because the clone happens
	// inside a `proc "c"` (context reset to runtime.default_context) but the free runs
	// from dns_request_free under the loop/teardown context. Routing alloc+free through
	// this stored allocator keeps the pair matched. Not the Runtime_State's allocator
	// (in Larva, a page runner's): a pool worker writes into this struct and may still
	// be resolving after a detached loop's owner has freed that allocator
	// (x-ror/larva#34). (results carries its own bound allocator — the
	// worker's, the heap — so plain delete() frees it correctly.)
	allocator: runtime.Allocator,
	hostname:  string, // owned clone (the worker reads it off-loop)
	family:    int, // 0 (any) | 4 | 6
	order:     int, // ORDER_* (which family to prefer / how to concatenate)
	all:       bool,
	results:   [dynamic]Dns_Lookup_Result, // heap (default allocator); full address list
	last_err:  net.DNS_Error, // worst resolver error seen, to distinguish NXDOMAIN from transient
	ok:        bool,
	err_code:  string, // static literal, e.g. "ENOTFOUND" / "EAI_AGAIN"
}

// make_dns_bindings builds the `native` object handed to js/node/dns.js.
make_dns_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "lookup", dns_lookup_cb)
	return bindings
}

// dns_lookup_cb(hostname, family, order, all, callback) — kicks off an async
// resolve. family is 0/4/6; order is ORDER_*; all selects single vs full result.
// The JS callback is invoked later as callback(errCode|null, [{address, family}, ...]).
dns_lookup_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 5 {
		if exception != nil do exception^ = make_js_error(ctx, "dns lookup requires (hostname, family, order, all, callback)")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]

	callback := callback_arg(ctx, args[4])
	if callback == nil {
		if exception != nil do exception^ = make_js_error(ctx, "dns lookup callback must be a function")
		return jsc.JSValueMakeUndefined(ctx)
	}

	loop := get_loop_from_ctx(ctx)
	if loop == nil {
		if exception != nil do exception^ = make_js_error(ctx, "dns: no event loop is bound to this context")
		return jsc.JSValueMakeUndefined(ctx)
	}

	// The heap, not the Runtime_State's allocator: the worker writes into the request
	// and may outlive the page (see Dns_Lookup_Request.allocator).
	alloc := runtime.heap_allocator()

	hostname, host_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if host_alloc do delete(hostname, context.allocator)

	req := new(Dns_Lookup_Request, alloc)
	req.allocator = alloc
	req.ctx = ctx
	req.callback = callback
	req.hostname = strings.clone(hostname, alloc) // the worker reads this off-loop
	req.family = int(jsc.JSValueToNumber(ctx, args[1], nil))
	req.order = int(jsc.JSValueToNumber(ctx, args[2], nil))
	req.all = jsc.JSValueToBoolean(ctx, args[3])

	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)callback)

	// Resolve off the loop on the loop's shared worker pool (bounded to
	// THREADPOOL_SIZE), instead of spawning a fresh OS thread per lookup. pool_submit
	// does the async_begin that keeps the loop alive until the completion posts, and on
	// a start failure undoes it itself — so we only unwind our own protect+alloc. The
	// pool's own `outstanding` list is the in-flight tracking: at teardown close_begin
	// releases the callback (dns_cancel) of a lookup a worker is running, and
	// dns_dispose frees each request whose completion never fires, replacing the
	// bespoke active_dns join logic.
	if !eventloop.pool_submit(loop, dns_work, dns_lookup_complete_cb, req, dns_dispose, dns_cancel) {
		jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)callback)
		delete(req.hostname, req.allocator)
		free(req, req.allocator)
		if exception != nil do exception^ = make_js_error(ctx, "dns: could not start resolver pool")
		return jsc.JSValueMakeUndefined(ctx)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// dns_query_family resolves one address family for req.hostname and appends the
// matching records (all of them, or just the first when first_only). Mirrors
// core:net's resolve_ip4/ip6 host path — including the `.local` mDNS branch — but
// keeps the whole record list instead of collapsing to the first endpoint, so
// lookup(all:true) returns every address the resolver knows about. Worker thread.
dns_query_family :: proc(req: ^Dns_Lookup_Request, type: net.DNS_Record_Type, family: int, first_only: bool) {
	recs: []net.DNS_Record
	err: net.DNS_Error
	is_mdns := ODIN_OS != .Windows && strings.has_suffix(req.hostname, ".local")
	if is_mdns && type == .IP4 {
		recs, err = net.get_dns_records_from_nameservers(
			req.hostname,
			.IP4,
			{net.IP4_mDNS_Broadcast},
			nil,
			context.temp_allocator,
		)
	} else if is_mdns {
		recs, err = net.get_dns_records_from_nameservers(
			req.hostname,
			.IP6,
			{net.IP6_mDNS_Broadcast},
			nil,
			context.temp_allocator,
		)
	} else {
		recs, err = net.get_dns_records_from_os(req.hostname, type, context.temp_allocator)
	}
	// Keep any reported resolver failure so the worker can tell a real "no such
	// host" (empty + .None) from a transient/system error (see dns_error_to_code).
	if err != .None do req.last_err = err
	for rec in recs {
		addr: net.Address
		#partial switch r in rec {
		case net.DNS_Record_IP4:
			addr = r.address
		case net.DNS_Record_IP6:
			addr = r.address
		case:
			continue
		}
		append(&req.results, Dns_Lookup_Result{addr = addr, family = family})
		if first_only do break
	}
}

// dns_work is the Pool_Work body: it runs off the loop on a pool worker, resolves
// the host, and stashes the results on the request. It touches ONLY req (never JSC
// nor the loop). The pool worker posts the completion (dns_lookup_complete_cb) and
// releases this worker's resolver scratch (free_all on its temp allocator) once this
// returns; that post_async handoff publishes these writes to the loop thread.
dns_work :: proc(user_data: rawptr) {
	req := cast(^Dns_Lookup_Request)user_data

	// An IP literal resolves to itself with its own family, ignoring the requested
	// family — this is what getaddrinfo (AI_NUMERICHOST) and Node both do.
	if lit := net.parse_address(req.hostname); lit != nil {
		#partial switch a in lit {
		case net.IP4_Address:
			append(&req.results, Dns_Lookup_Result{addr = a, family = 4})
		case net.IP6_Address:
			append(&req.results, Dns_Lookup_Result{addr = a, family = 6})
		}
	} else {
		want4 := req.family == 0 || req.family == 4
		want6 := req.family == 0 || req.family == 6
		prefer6 := req.order == ORDER_IPV6FIRST
		if req.all {
			// Full enumeration of every requested family, concatenated per order.
			if prefer6 {
				if want6 do dns_query_family(req, .IP6, 6, false)
				if want4 do dns_query_family(req, .IP4, 4, false)
			} else {
				if want4 do dns_query_family(req, .IP4, 4, false)
				if want6 do dns_query_family(req, .IP6, 6, false)
			}
		} else {
			// Single address: first of the preferred family, else fall back. Querying
			// the preferred family first also avoids the second query in the common case.
			if prefer6 {
				if want6 do dns_query_family(req, .IP6, 6, true)
				if len(req.results) == 0 && want4 do dns_query_family(req, .IP4, 4, true)
			} else {
				if want4 do dns_query_family(req, .IP4, 4, true)
				if len(req.results) == 0 && want6 do dns_query_family(req, .IP6, 6, true)
			}
		}
	}

	req.ok = len(req.results) > 0
	if !req.ok do req.err_code = dns_error_to_code(req.last_err)
}

// dns_error_to_code maps a failed lookup to a Node getaddrinfo error code. A real
// "no such host" surfaces from core:net as empty records with .None, which we
// report as ENOTFOUND. The errors core:net DOES report (no/unsendable nameserver,
// malformed response, missing resolv.conf/hosts) are transient/system failures —
// Node's EAI_AGAIN — so they are no longer flattened into ENOTFOUND. Caveat:
// core:net swallows a per-nameserver recv timeout (it just tries the next server
// and ends with .None), so a pure timeout still reads as ENOTFOUND here; matching
// Node's EAI_AGAIN for that case needs a resolver that surfaces the timeout.
dns_error_to_code :: proc(e: net.DNS_Error) -> string {
	#partial switch e {
	case .Connection_Error, .Server_Error, .System_Error, .Invalid_Resolv_Config_Error, .Invalid_Hosts_Config_Error:
		return "EAI_AGAIN"
	}
	return "ENOTFOUND"
}

// dns_lookup_complete_cb runs on the loop thread once resolution finishes: it
// builds the JS result and invokes the callback. Reading req.* here is safe —
// post_async published the worker's writes.
dns_lookup_complete_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	req := cast(^Dns_Lookup_Request)user_data
	ctx := req.ctx

	code_val, addrs_val: jsc.JSValueRef
	if req.ok {
		code_val = jsc.JSValueMakeNull(ctx)
		// Set each entry into the array as it is built — never park unrooted JSValueRefs in
		// a temp_allocator slice for JSObjectMakeArray (GC-invisible heap → use-after-free;
		// see build_string_array / http.odin parseRequest).
		n := len(req.results)
		arr := jsc.JSObjectMakeArray(ctx, 0, nil, nil)
		for i in 0 ..< n {
			o := jsc.JSObjectMake(ctx, nil, nil)
			s := net.address_to_string(req.results[i].addr, context.temp_allocator)
			set_named(ctx, o, "address", js_string_value(ctx, s))
			set_named(ctx, o, "family", jsc.JSValueMakeNumber(ctx, f64(req.results[i].family)))
			jsc.JSObjectSetPropertyAtIndex(ctx, arr, c.uint(i), cast(jsc.JSValueRef)o, nil)
		}
		addrs_val = cast(jsc.JSValueRef)arr
	} else {
		code_val = js_string_value(ctx, req.err_code)
		addrs_val = jsc.JSValueMakeNull(ctx)
	}

	cb_args := [2]jsc.JSValueRef{code_val, addrs_val}
	exception: jsc.JSValueRef
	invoke_user_callback(ctx, req.callback, raw_data(cb_args[:]), 2, &exception)
	if exception != nil {
		report_uncaught(ctx, exception)
		mark_async_failed(ctx)
	}

	dns_request_free(req)
}

// --- request teardown ---

// dns_request_free releases everything the request owns and unprotects the JS
// callback (WITHOUT invoking it) if it is still held. It runs from the completion
// (dns_lookup_complete_cb, after the callback has fired) or from dns_dispose (pool
// teardown, before it fires). It never races a worker: the pool disposes a job a
// worker took only once that worker has exited.
dns_request_free :: proc(req: ^Dns_Lookup_Request) {
	if req == nil do return
	if req.callback != nil {
		jsc.JSValueUnprotect(req.ctx, cast(jsc.JSValueRef)req.callback)
		req.callback = nil
	}
	delete(req.results)
	delete(req.hostname, req.allocator)
	free(req, req.allocator)
}

// dns_dispose is the Pool_Dispose hook: it frees a request whose completion will
// never run because the loop was torn down (see threadpool.odin). Exactly one of
// {dns_lookup_complete_cb, dns_dispose} runs per request. For a lookup no worker took
// it runs in close_begin, with the context alive, and unprotects the callback; for one
// a worker took, dns_cancel already did, and this runs once the worker has exited —
// maybe after the context is gone, maybe on that worker's thread — freeing heap
// memory only.
dns_dispose :: proc(user_data: rawptr) {
	context = runtime.default_context()
	dns_request_free(cast(^Dns_Lookup_Request)user_data)
}

// dns_cancel is the Pool_Cancel hook: close_begin calls it on the loop thread, with the
// context alive, for a lookup a worker is running, so the JS callback is unprotected
// before the page releases its context. dns_work never reads req.callback or req.ctx.
dns_cancel :: proc(user_data: rawptr) {
	req := cast(^Dns_Lookup_Request)user_data
	if req.callback != nil {
		jsc.JSValueUnprotect(req.ctx, cast(jsc.JSValueRef)req.callback)
		req.callback = nil
	}
}
