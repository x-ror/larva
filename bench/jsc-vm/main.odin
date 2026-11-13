// Spike: measure JSC VM (JSContextGroup) costs to size Larva's VM pool (#4).
// Build: odin build bench/jsc-vm -o:speed -out:/tmp/jsc-vm
// Run one scenario per process: /tmp/jsc-vm pkg/runtime/js/internal <A|B|C|D|E|F|G|H>
// Results and conclusions: docs/LARVA.md §2 and the comments in pkg/runtime/vm_pool.odin.
package spike_vm

import "core:c"
import "core:fmt"
import "core:os"
import "core:strings"
import "core:time"

foreign import jsc "system:javascriptcoregtk-6.0"
foreign import glib "system:glib-2.0"
@(default_calling_convention = "c")
foreign glib {
	g_main_context_iteration :: proc(ctx: rawptr, may_block: b32) -> b32 ---
	g_main_context_pending :: proc(ctx: rawptr) -> b32 ---
}

Ctx :: rawptr
Group :: rawptr
Str :: rawptr
Val :: rawptr
Should_Terminate :: #type proc "c" (ctx: Ctx, data: rawptr) -> bool

@(default_calling_convention = "c")
foreign jsc {
	JSContextGroupCreate :: proc() -> Group ---
	JSContextGroupRelease :: proc(g: Group) ---
	JSGlobalContextCreate :: proc(cls: rawptr) -> Ctx ---
	JSGlobalContextCreateInGroup :: proc(g: Group, cls: rawptr) -> Ctx ---
	JSGlobalContextRelease :: proc(ctx: Ctx) ---
	JSGarbageCollect :: proc(ctx: Ctx) ---
	JSStringCreateWithUTF8CString :: proc(s: cstring) -> Str ---
	JSStringRelease :: proc(s: Str) ---
	JSEvaluateScript :: proc(ctx: Ctx, script: Str, this: rawptr, url: Str, line: c.int, exc: ^Val) -> Val ---
	JSContextGroupSetExecutionTimeLimit :: proc(g: Group, limit: f64, cb: Should_Terminate, data: rawptr) ---
	JSContextGroupClearExecutionTimeLimit :: proc(g: Group) ---
	JSSynchronousGarbageCollectForDebugging :: proc(ctx: Ctx) ---
}

count_timerfds :: proc() -> (timerfds: int, total: int) {
	dir, err := os.open("/proc/self/fd")
	if err != nil do return
	defer os.close(dir)
	infos, _ := os.read_dir(dir, -1, context.temp_allocator)
	for fi in infos {
		total += 1
		target, lerr := os.read_link(fi.fullpath, context.temp_allocator)
		if lerr == nil && strings.contains(target, "timerfd") do timerfds += 1
	}
	return
}

rss_kb :: proc() -> int {
	data, err := os.read_entire_file("/proc/self/status", context.temp_allocator)
	if err != nil do return -1
	text := string(data)
	for line in strings.split_lines_iterator(&text) {
		if strings.has_prefix(line, "VmRSS:") {
			n := 0
			for ch in line do if ch >= '0' && ch <= '9' do n = n * 10 + int(ch - '0')
			return n
		}
	}
	return -1
}

g_workload: cstring
g_url: Str

run_workload :: proc(ctx: Ctx) -> bool {
	s := JSStringCreateWithUTF8CString(g_workload)
	defer JSStringRelease(s)
	exc: Val
	JSEvaluateScript(ctx, s, nil, g_url, 1, &exc)
	return exc == nil
}

eval_cstr :: proc(ctx: Ctx, src: cstring) -> (ok: bool) {
	s := JSStringCreateWithUTF8CString(src)
	defer JSStringRelease(s)
	exc: Val
	JSEvaluateScript(ctx, s, nil, nil, 1, &exc)
	return exc == nil
}

terminate_always :: proc "c" (ctx: Ctx, data: rawptr) -> bool {return true}

build_workload :: proc(dir: string) -> cstring {
	files := []string{"primordials.js", "events.js", "buffer.js", "url.js", "encoding.js", "streams.js", "fetch.js", "util.js"}
	b := strings.builder_make()
	// Permissive stubs so each factory's top level runs (errors are swallowed).
	strings.write_string(&b, "var __stub = new Proxy(function(){}, {get:function(t,k){return k===Symbol.toPrimitive?function(){return 0}:__stub}, apply:function(){return __stub}, construct:function(){return __stub}});\nvar __ok=0;\n")
	for f in files {
		data, err := os.read_entire_file(fmt.tprintf("%s/%s", dir, f), context.allocator)
		if err != nil {fmt.eprintln("missing", f); continue}
		src := strings.trim_right_space(string(data))
		src = strings.trim_suffix(src, ";")
		strings.write_string(&b, "try { (")
		strings.write_string(&b, src)
		strings.write_string(&b, ")(function(){return __stub}, {exports:{}}, {}, __stub); __ok++ } catch (e) {}\n")
	}
	// Plus a CPU-ish chunk that JITs.
	strings.write_string(&b, "var acc=0; for (var i=0;i<200000;i++){ acc += ('k'+i).length } \n")
	return strings.clone_to_cstring(strings.to_string(b))
}

main :: proc() {
	dir := len(os.args) > 1 ? os.args[1] : "pkg/runtime/js/internal"
	mode := len(os.args) > 2 ? os.args[2] : "all"
	N := 100
	g_workload = build_workload(dir)
	g_url = JSStringCreateWithUTF8CString("workload.js")
	fmt.printf("workload: %d KB\n", len(string(g_workload)) / 1024)
	{
		ctx := JSGlobalContextCreate(nil)
		ok := run_workload(ctx)
		t0 := time.tick_now()
		ok_n := eval_cstr(ctx, "if (__ok < 8) throw new Error('only ' + __ok + ' factories ran')")
		fmt.printf("workload check: parsed+ran=%v all-factories=%v (%.2f ms)\n", ok, ok_n, time.duration_milliseconds(time.tick_since(t0)))
		JSGlobalContextRelease(ctx)
	}

	base_tfd, base_fd := count_timerfds()
	fmt.printf("baseline: timerfd=%d fds=%d rss=%d KB\n\n", base_tfd, base_fd, rss_kb())

	// H) do VM timerfds close once the GLib main context is iterated?
	if mode == "H" {
		tf0, _ := count_timerfds()
		for _ in 0 ..< 50 {
			g := JSContextGroupCreate()
			ctx := JSGlobalContextCreateInGroup(g, nil)
			run_workload(ctx)
			JSGlobalContextRelease(ctx)
			JSContextGroupRelease(g)
		}
		tf1, _ := count_timerfds()
		spins := 0
		for _ in 0 ..< 2000 {
			for g_main_context_iteration(nil, false) do spins += 1
			time.sleep(time.Millisecond)
		}
		tf2, _ := count_timerfds()
		fmt.printf("H 50 VMs released: timerfd +%d; after iterating GLib default context (%d dispatches): +%d\n", tf1 - tf0, spins, tf2 - tf0)
	}
	// A) lava-style: JSGlobalContextCreate (implicit VM) + release, N times.
	if mode == "all" || mode == "A" {
		t0 := time.tick_now()
		for _ in 0 ..< N {
			ctx := JSGlobalContextCreate(nil)
			run_workload(ctx)
			JSGlobalContextRelease(ctx)
		}
		el := time.tick_since(t0)
		tfd, fd := count_timerfds()
		fmt.printf("A implicit VM per page   : %6.2f ms/page  timerfd=%d fds=%d rss=%d KB\n", time.duration_milliseconds(el) / f64(N), tfd, fd, rss_kb())
	}
	// B) cold explicit group per page, released after.
	if mode == "all" || mode == "B" {
		t0 := time.tick_now()
		for _ in 0 ..< N {
			g := JSContextGroupCreate()
			ctx := JSGlobalContextCreateInGroup(g, nil)
			run_workload(ctx)
			JSGlobalContextRelease(ctx)
			JSContextGroupRelease(g)
		}
		el := time.tick_since(t0)
		tfd, fd := count_timerfds()
		fmt.printf("B explicit group per page: %6.2f ms/page  timerfd=%d fds=%d rss=%d KB\n", time.duration_milliseconds(el) / f64(N), tfd, fd, rss_kb())
	}
	// C) warm: one group reused sequentially, a fresh global per page.
	if mode == "all" || mode == "C" {
		g := JSContextGroupCreate()
		first: time.Duration
		t0 := time.tick_now()
		for i in 0 ..< N {
			ti := time.tick_now()
			ctx := JSGlobalContextCreateInGroup(g, nil)
			run_workload(ctx)
			if i % 20 == 19 do JSGarbageCollect(ctx)
			JSGlobalContextRelease(ctx)
			if i == 0 do first = time.tick_since(ti)
		}
		el := time.tick_since(t0)
		tfd, fd := count_timerfds()
		fmt.printf("C warm pooled VM         : %6.2f ms/page (first %.2f ms)  timerfd=%d fds=%d rss=%d KB\n", time.duration_milliseconds(el) / f64(N), time.duration_milliseconds(first), tfd, fd, rss_kb())
		JSContextGroupRelease(g)
	}
	// D) many live VMs on one thread: memory per idle VM with one page loaded.
	if mode == "all" || mode == "D" {
		M :: 50
		r0 := rss_kb()
		groups: [M]Group
		ctxs: [M]Ctx
		t0 := time.tick_now()
		for i in 0 ..< M {
			groups[i] = JSContextGroupCreate()
			ctxs[i] = JSGlobalContextCreateInGroup(groups[i], nil)
			run_workload(ctxs[i])
		}
		el := time.tick_since(t0)
		r1 := rss_kb()
		tfd, _ := count_timerfds()
		fmt.printf("D %d live VMs             : %.0f KB RSS per VM+page, %.2f ms each, timerfd=%d\n", M, f64(r1 - r0) / M, time.duration_milliseconds(el) / M, tfd)
		for i in 0 ..< M {JSGlobalContextRelease(ctxs[i]); JSContextGroupRelease(groups[i])}
		tfd2, _ := count_timerfds()
		fmt.printf("  after release           : rss=%d KB timerfd=%d\n", rss_kb(), tfd2)
	}
	// F) can a VM be freed? sync GC before releasing the last context + group.
	if mode == "all" || mode == "F" {
		M :: 50
		r0 := rss_kb()
		tf0, _ := count_timerfds()
		for _ in 0 ..< M {
			g := JSContextGroupCreate()
			ctx := JSGlobalContextCreateInGroup(g, nil)
			run_workload(ctx)
			eval_cstr(ctx, "for (var k in this) { try { delete this[k] } catch (e) {} }")
			JSSynchronousGarbageCollectForDebugging(ctx)
			JSGlobalContextRelease(ctx)
			JSContextGroupRelease(g)
		}
		tf1, _ := count_timerfds()
		fmt.printf("F %d VMs sync-GC'd+released: rss delta %+d KB, timerfd delta %+d\n", M, rss_kb() - r0, tf1 - tf0)
	}
	// G) warm VM, 500 pages, sync GC every 50: does RSS stay flat?
	if mode == "all" || mode == "G" {
		g := JSContextGroupCreate()
		r0 := rss_kb()
		mid := 0
		for i in 0 ..< 500 {
			ctx := JSGlobalContextCreateInGroup(g, nil)
			run_workload(ctx)
			if i % 50 == 49 do JSSynchronousGarbageCollectForDebugging(ctx)
			JSGlobalContextRelease(ctx)
			if i == 99 do mid = rss_kb()
		}
		fmt.printf("G warm VM 500 pages       : rss after 100 pages %+d KB, after 500 %+d KB\n", mid - r0, rss_kb() - r0)
		JSContextGroupRelease(g)
	}
	// E) execution time limit: runaway script is stopped, the VM stays usable.
	if mode == "all" || mode == "E" {
		g := JSContextGroupCreate()
		JSContextGroupSetExecutionTimeLimit(g, 0.2, terminate_always, nil)
		ctx := JSGlobalContextCreateInGroup(g, nil)
		t0 := time.tick_now()
		ok := eval_cstr(ctx, "while(true){}")
		el := time.tick_since(t0)
		ctx2 := JSGlobalContextCreateInGroup(g, nil)
		ok2 := eval_cstr(ctx2, "var x = 0; for (var i=0;i<1000;i++) x+=i;")
		// Many short entries: does the limit accumulate across entries? (expected: no)
		total := time.Duration(0)
		killed := false
		for _ in 0 ..< 10 {
			ti := time.tick_now()
			if !eval_cstr(ctx2, "var s=Date.now(); while(Date.now()-s<50){}") do killed = true
			total += time.tick_since(ti)
		}
		fmt.printf("E time limit 200ms       : runaway stopped=%v after %.0f ms; same VM usable after=%v; 10x50ms entries killed=%v (total %.0f ms)\n", !ok, time.duration_milliseconds(el), ok2, killed, time.duration_milliseconds(total))
		JSGlobalContextRelease(ctx)
		JSGlobalContextRelease(ctx2)
		JSContextGroupRelease(g)
	}
	time.sleep(3 * time.Second)
	tfd, _ := count_timerfds()
	fmt.printf("  [%s] settled 3s: rss=%d KB timerfd=%d\n", mode, rss_kb(), tfd)
}
