package lava_runtime

import "base:runtime"
import "core:c"
import "core:fmt"
import "core:os"
import jsc "lava:pkg/jsc"

// node:os native bridge. js/node/os.js implements the public surface and
// computes everything that is a pure function of process.platform/process.env
// (homedir/tmpdir/EOL/devNull/endianness/constants); the live system numbers come
// from here. The platform-specific syscalls live in os_posix.odin (Linux+Darwin
// shared, via core:sys/posix plus a few hand-declared libc/ifaddrs bindings),
// os_linux.odin, os_darwin.odin and os_windows.odin. This file is platform-neutral
// glue: it builds the JS values from the plain Odin data the platform procs return.
//
// Non-deterministic values (memory, uptime, cpus, load average, interfaces) are
// returned as-is and asserted only by shape in the node-compat oracle.

// Os_Cpu mirrors one entry of os.cpus(): { model, speed, times:{user,nice,sys,
// idle,irq} }. Tick counts are already converted to milliseconds by the platform
// layer (Node/libuv report ms). speed is in MHz (0 when the host does not expose
// a frequency, matching Node on virtualized/ARM hosts).
Os_Cpu :: struct {
	model:                      string,
	speed:                      int,
	user, nice, sys, idle, irq: i64,
}

// Os_Net_Iface is one flat interface address record; js/node/os.js groups
// these by name and decorates each with the string family and the CIDR. family is
// 4 or 6; scopeid is only meaningful for IPv6 (0 otherwise). mac is "xx:..:xx".
Os_Net_Iface :: struct {
	name:     string,
	address:  string,
	netmask:  string,
	family:   int,
	mac:      string,
	internal: bool,
	scopeid:  u32,
}

// Os_User_Info is os.userInfo(): a null shell is signalled by has_shell == false.
Os_User_Info :: struct {
	uid:       int,
	gid:       int,
	username:  string,
	homedir:   string,
	shell:     string,
	has_shell: bool,
}

// Uname_Field selects which utsname field the os_uname accessor returns, so the
// four string accessors (type/release/version/machine) share one syscall path.
Uname_Field :: enum {
	SYSNAME,
	RELEASE,
	VERSION,
	MACHINE,
}

// os_getenv_or reads an environment variable into temp memory, returning the
// fallback when unset. Used by the platform layer for password-db / user fallbacks.
os_getenv_or :: proc(key: string, fallback: string) -> string {
	v := os.get_env(key, context.temp_allocator)
	if v == "" {
		return fallback
	}
	return v
}

// make_os_bindings builds the `native` object handed to js/node/os.js.
make_os_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "hostname", os_hostname_cb)
	inject_native_function(ctx, bindings, "type", os_type_cb)
	inject_native_function(ctx, bindings, "release", os_release_cb)
	inject_native_function(ctx, bindings, "version", os_version_cb)
	inject_native_function(ctx, bindings, "machine", os_machine_cb)
	inject_native_function(ctx, bindings, "homedir", os_homedir_cb)
	inject_native_function(ctx, bindings, "totalmem", os_totalmem_cb)
	inject_native_function(ctx, bindings, "freemem", os_freemem_cb)
	inject_native_function(ctx, bindings, "uptime", os_uptime_cb)
	inject_native_function(ctx, bindings, "loadavg", os_loadavg_cb)
	inject_native_function(ctx, bindings, "cpus", os_cpus_cb)
	inject_native_function(ctx, bindings, "availableParallelism", os_avail_parallelism_cb)
	inject_native_function(ctx, bindings, "networkInterfaces", os_network_interfaces_cb)
	inject_native_function(ctx, bindings, "userInfo", os_userinfo_cb)
	inject_native_function(ctx, bindings, "getPriority", os_getpriority_cb)
	inject_native_function(ctx, bindings, "setPriority", os_setpriority_cb)
	return bindings
}

// --- string accessors -------------------------------------------------------

os_hostname_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return js_string_value(ctx, os_hostname())
}

os_type_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return js_string_value(ctx, os_uname(.SYSNAME))
}

os_release_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return js_string_value(ctx, os_uname(.RELEASE))
}

os_version_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return js_string_value(ctx, os_uname(.VERSION))
}

os_machine_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return js_string_value(ctx, os_uname(.MACHINE))
}

os_homedir_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return js_string_value(ctx, os_user_info().homedir)
}

// --- numeric accessors ------------------------------------------------------

os_totalmem_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return jsc.JSValueMakeNumber(ctx, f64(os_totalmem()))
}

os_freemem_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return jsc.JSValueMakeNumber(ctx, f64(os_freemem()))
}

os_uptime_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return jsc.JSValueMakeNumber(ctx, os_uptime())
}

os_avail_parallelism_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	n := os_avail_parallelism()
	if n < 1 do n = 1
	return jsc.JSValueMakeNumber(ctx, f64(n))
}

// --- structured accessors ---------------------------------------------------

os_loadavg_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	la := os_loadavg()
	vals := [3]jsc.JSValueRef {
		jsc.JSValueMakeNumber(ctx, la[0]),
		jsc.JSValueMakeNumber(ctx, la[1]),
		jsc.JSValueMakeNumber(ctx, la[2]),
	}
	return cast(jsc.JSValueRef)jsc.JSObjectMakeArray(ctx, 3, raw_data(vals[:]), nil)
}

os_cpus_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	// Set each entry into the array as it is built — never park unrooted JSValueRefs in a
	// temp_allocator slice for JSObjectMakeArray (GC-invisible heap → use-after-free; see
	// build_string_array / http.odin parseRequest).
	cpus := os_cpus()
	n := len(cpus)
	arr := jsc.JSObjectMakeArray(ctx, 0, nil, nil)
	for i in 0 ..< n {
		cpu := cpus[i]
		o := jsc.JSObjectMake(ctx, nil, nil)
		set_named(ctx, o, "model", js_string_value(ctx, cpu.model))
		set_named(ctx, o, "speed", jsc.JSValueMakeNumber(ctx, f64(cpu.speed)))
		times := jsc.JSObjectMake(ctx, nil, nil)
		set_named(ctx, times, "user", jsc.JSValueMakeNumber(ctx, f64(cpu.user)))
		set_named(ctx, times, "nice", jsc.JSValueMakeNumber(ctx, f64(cpu.nice)))
		set_named(ctx, times, "sys", jsc.JSValueMakeNumber(ctx, f64(cpu.sys)))
		set_named(ctx, times, "idle", jsc.JSValueMakeNumber(ctx, f64(cpu.idle)))
		set_named(ctx, times, "irq", jsc.JSValueMakeNumber(ctx, f64(cpu.irq)))
		set_named(ctx, o, "times", cast(jsc.JSValueRef)times)
		jsc.JSObjectSetPropertyAtIndex(ctx, arr, c.uint(i), cast(jsc.JSValueRef)o, nil)
	}
	return cast(jsc.JSValueRef)arr
}

os_network_interfaces_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	// Set each entry into the array as it is built — never park unrooted JSValueRefs in a
	// temp_allocator slice for JSObjectMakeArray (GC-invisible heap → use-after-free; see
	// build_string_array / http.odin parseRequest).
	ifaces := os_network_interfaces()
	n := len(ifaces)
	arr := jsc.JSObjectMakeArray(ctx, 0, nil, nil)
	for i in 0 ..< n {
		it := ifaces[i]
		o := jsc.JSObjectMake(ctx, nil, nil)
		set_named(ctx, o, "name", js_string_value(ctx, it.name))
		set_named(ctx, o, "address", js_string_value(ctx, it.address))
		set_named(ctx, o, "netmask", js_string_value(ctx, it.netmask))
		set_named(ctx, o, "family", jsc.JSValueMakeNumber(ctx, f64(it.family)))
		set_named(ctx, o, "mac", js_string_value(ctx, it.mac))
		set_named(ctx, o, "internal", jsc.JSValueMakeBoolean(ctx, b32(it.internal)))
		set_named(ctx, o, "scopeid", jsc.JSValueMakeNumber(ctx, f64(it.scopeid)))
		jsc.JSObjectSetPropertyAtIndex(ctx, arr, c.uint(i), cast(jsc.JSValueRef)o, nil)
	}
	return cast(jsc.JSValueRef)arr
}

os_userinfo_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	ui := os_user_info()
	o := jsc.JSObjectMake(ctx, nil, nil)
	set_named(ctx, o, "uid", jsc.JSValueMakeNumber(ctx, f64(ui.uid)))
	set_named(ctx, o, "gid", jsc.JSValueMakeNumber(ctx, f64(ui.gid)))
	set_named(ctx, o, "username", js_string_value(ctx, ui.username))
	set_named(ctx, o, "homedir", js_string_value(ctx, ui.homedir))
	if ui.has_shell {
		set_named(ctx, o, "shell", js_string_value(ctx, ui.shell))
	} else {
		set_named(ctx, o, "shell", jsc.JSValueMakeNull(ctx))
	}
	return cast(jsc.JSValueRef)o
}

// --- priority ---------------------------------------------------------------
//
// js/node/os.js validates pid/priority (int32; priority in [-20, 19]) and
// throws the Node-shaped TypeError/RangeError before calling these, so the native
// side only performs the syscall. A failed syscall (unknown pid -> ESRCH, or
// EPERM) becomes an ERR_SYSTEM_ERROR, matching Node's _getPriority/_setPriority.

os_getpriority_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	pid := 0
	if argument_count >= 1 {
		pid = int(jsc.JSValueToNumber(ctx, arguments[0], nil))
	}
	value, err := os_get_priority(pid)
	if err != 0 {
		if exception != nil do exception^ = make_os_system_error(ctx, "getpriority", err)
		return jsc.JSValueMakeUndefined(ctx)
	}
	return jsc.JSValueMakeNumber(ctx, f64(value))
}

os_setpriority_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 {
		if exception != nil do exception^ = make_js_error(ctx, "os.setPriority requires (pid, priority)")
		return jsc.JSValueMakeUndefined(ctx)
	}
	pid := int(jsc.JSValueToNumber(ctx, arguments[0], nil))
	value := int(jsc.JSValueToNumber(ctx, arguments[1], nil))
	if err := os_set_priority(pid, value); err != 0 {
		if exception != nil do exception^ = make_os_system_error(ctx, "setpriority", err)
		return jsc.JSValueMakeUndefined(ctx)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// --- file-internal helpers --------------------------------------------------

// make_os_system_error builds the Node SystemError thrown when a priority syscall
// fails: code ERR_SYSTEM_ERROR plus the errno/syscall fields callers inspect. The
// (name, message, code) shape comes from the centralized factory (errors.odin);
// errno/syscall are the SystemError-specific extras the generic factory doesn't
// model. The errno is reported as the negative value, as Node/libuv do.
@(private = "file")
make_os_system_error :: proc(ctx: jsc.JSContextRef, syscall: string, err: int) -> jsc.JSValueRef {
	msg := fmt.tprintf("A system error occurred: %s returned errno %d", syscall, err)
	e := make_native_error(ctx, "SystemError", msg, "ERR_SYSTEM_ERROR")
	if jsc.JSValueIsObject(ctx, e) {
		o := cast(jsc.JSObjectRef)e
		set_named(ctx, o, "errno", jsc.JSValueMakeNumber(ctx, f64(-err)))
		set_named(ctx, o, "syscall", js_string_value(ctx, syscall))
	}
	return e
}
