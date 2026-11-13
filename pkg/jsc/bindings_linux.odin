#+build linux
package jsc

import "core:c"

// Links against the GTK JavaScriptCore library.
// Build with: $(pkg-config --libs javascriptcoregtk-6.0).
foreign import jsc_lib "system:javascriptcoregtk-6.0"

@(default_calling_convention = "c")
foreign jsc_lib {
	JSGlobalContextCreate :: proc(global_object_class: JSClassRef) -> JSGlobalContextRef ---
	JSGlobalContextRelease :: proc(ctx: JSGlobalContextRef) ---
	// Context groups (one JSC::VM each). JSGlobalContextCreate makes a fresh VM per
	// context; Larva pools VMs per thread instead (pkg/runtime/vm_pool.odin).
	JSContextGroupCreate :: proc() -> JSContextGroupRef ---
	JSContextGroupRetain :: proc(group: JSContextGroupRef) -> JSContextGroupRef ---
	JSContextGroupRelease :: proc(group: JSContextGroupRef) ---
	JSGlobalContextCreateInGroup :: proc(group: JSContextGroupRef, global_object_class: JSClassRef) -> JSGlobalContextRef ---
	// Exported, but declared in WebKit's JSContextRefPrivate.h. The watchdog measures
	// time since the VM was entered; when `limit` seconds pass, `callback` decides
	// whether to terminate the running script. Per VM, per entry, not cumulative.
	JSContextGroupSetExecutionTimeLimit :: proc(group: JSContextGroupRef, limit: f64, callback: JSShouldTerminateCallback, ctx: rawptr) ---
	JSContextGroupClearExecutionTimeLimit :: proc(group: JSContextGroupRef) ---
	// Exported by libjavascriptcoregtk (declared in WebKit's JSContextRefPrivate.h,
	// not the public C API headers). The handler is invoked as fn(promise, reason)
	// when a promise rejects with no handler at a microtask checkpoint.
	JSGlobalContextSetUnhandledRejectionCallback :: proc(ctx: JSGlobalContextRef, function: JSObjectRef, exception: ^JSValueRef) ---
	// A context group is JSC::VM* under the C API — used by host_function.odin to
	// pass VM& to the private JSFunction::create.
	JSContextGetGroup :: proc(ctx: JSContextRef) -> rawptr ---

	JSStringCreateWithUTF8CString :: proc(string: cstring) -> JSStringRef ---
	JSStringCreateWithCharacters :: proc(chars: [^]JSChar, num_chars: c.size_t) -> JSStringRef ---
	// Private API (JSStringRefPrivate.h): StringImpl without copying the buffer.
	// Buffer must outlive the JSString (no freer) — only for immortal/static data,
	// or for a window where the buffer is not freed until after JSStringRelease.
	JSStringCreateWithCharactersNoCopy :: proc(chars: [^]JSChar, num_chars: c.size_t) -> JSStringRef ---
	JSStringGetLength :: proc(string: JSStringRef) -> c.size_t ---
	JSStringGetCharactersPtr :: proc(string: JSStringRef) -> [^]JSChar ---
	JSStringGetMaximumUTF8CStringSize :: proc(string: JSStringRef) -> c.size_t ---
	JSStringGetUTF8CString :: proc(string: JSStringRef, buffer: [^]byte, buffer_size: c.size_t) -> c.size_t ---
	JSStringRelease :: proc(string: JSStringRef) ---
	JSStringIsEqualToUTF8CString :: proc(a: JSStringRef, b: cstring) -> bool ---

	JSValueMakeUndefined :: proc(ctx: JSContextRef) -> JSValueRef ---
	JSValueMakeNull :: proc(ctx: JSContextRef) -> JSValueRef ---
	JSValueMakeBoolean :: proc(ctx: JSContextRef, boolean: b32) -> JSValueRef ---
	JSValueMakeNumber :: proc(ctx: JSContextRef, number: f64) -> JSValueRef ---
	JSValueMakeString :: proc(ctx: JSContextRef, string: JSStringRef) -> JSValueRef ---
	JSValueMakeFromJSONString :: proc(ctx: JSContextRef, string: JSStringRef) -> JSValueRef ---

	JSValueGetType :: proc(ctx: JSContextRef, value: JSValueRef) -> JSType ---
	JSValueIsUndefined :: proc(ctx: JSContextRef, value: JSValueRef) -> bool ---
	JSValueIsNull :: proc(ctx: JSContextRef, value: JSValueRef) -> bool ---
	JSValueIsBoolean :: proc(ctx: JSContextRef, value: JSValueRef) -> bool ---
	JSValueIsNumber :: proc(ctx: JSContextRef, value: JSValueRef) -> bool ---
	JSValueIsString :: proc(ctx: JSContextRef, value: JSValueRef) -> bool ---
	JSValueIsObject :: proc(ctx: JSContextRef, value: JSValueRef) -> bool ---
	JSValueIsArray :: proc(ctx: JSContextRef, value: JSValueRef) -> bool ---
	JSValueIsStrictEqual :: proc(ctx: JSContextRef, a: JSValueRef, b: JSValueRef) -> bool ---

	JSValueToBoolean :: proc(ctx: JSContextRef, value: JSValueRef) -> bool ---
	JSValueToNumber :: proc(ctx: JSContextRef, value: JSValueRef, exception: ^JSValueRef) -> f64 ---
	JSValueToStringCopy :: proc(ctx: JSContextRef, value: JSValueRef, exception: ^JSValueRef) -> JSStringRef ---

	JSContextGetGlobalObject :: proc(ctx: JSContextRef) -> JSObjectRef ---

	JSObjectMake :: proc(ctx: JSContextRef, js_class: JSClassRef, data: rawptr) -> JSObjectRef ---
	JSObjectMakeFunctionWithCallback :: proc(ctx: JSContextRef, name: JSStringRef, call_as_function: JSObjectCallAsFunctionCallback) -> JSObjectRef ---
	JSObjectMakeArray :: proc(ctx: JSContextRef, argument_count: c.size_t, arguments: [^]JSValueRef, exception: ^JSValueRef) -> JSObjectRef ---
	JSObjectMakeError :: proc(ctx: JSContextRef, argument_count: c.size_t, arguments: [^]JSValueRef, exception: ^JSValueRef) -> JSObjectRef ---

	JSObjectGetProperty :: proc(ctx: JSContextRef, object: JSObjectRef, property_name: JSStringRef, exception: ^JSValueRef) -> JSValueRef ---
	JSObjectSetProperty :: proc(ctx: JSContextRef, object: JSObjectRef, property_name: JSStringRef, value: JSValueRef, attributes: JSPropertyAttributes, exception: ^JSValueRef) ---
	JSObjectHasProperty :: proc(ctx: JSContextRef, object: JSObjectRef, property_name: JSStringRef) -> bool ---
	JSObjectDeleteProperty :: proc(ctx: JSContextRef, object: JSObjectRef, property_name: JSStringRef, exception: ^JSValueRef) -> bool ---
	JSObjectGetPropertyAtIndex :: proc(ctx: JSContextRef, object: JSObjectRef, property_index: c.uint, exception: ^JSValueRef) -> JSValueRef ---
	JSObjectSetPropertyAtIndex :: proc(ctx: JSContextRef, object: JSObjectRef, property_index: c.uint, value: JSValueRef, exception: ^JSValueRef) ---

	JSObjectCallAsFunction :: proc(ctx: JSContextRef, object: JSObjectRef, this_object: JSObjectRef, argument_count: c.size_t, arguments: [^]JSValueRef, exception: ^JSValueRef) -> JSValueRef ---
	JSObjectCallAsConstructor :: proc(ctx: JSContextRef, object: JSObjectRef, argument_count: c.size_t, arguments: [^]JSValueRef, exception: ^JSValueRef) -> JSObjectRef ---
	JSObjectIsFunction :: proc(ctx: JSContextRef, object: JSObjectRef) -> bool ---
	JSObjectIsConstructor :: proc(ctx: JSContextRef, object: JSObjectRef) -> bool ---

	JSObjectGetPrivate :: proc(object: JSObjectRef) -> rawptr ---
	JSObjectSetPrivate :: proc(object: JSObjectRef, data: rawptr) -> bool ---

	JSClassCreate :: proc(definition: ^JSClassDefinition) -> JSClassRef ---
	JSClassRetain :: proc(js_class: JSClassRef) -> JSClassRef ---
	JSClassRelease :: proc(js_class: JSClassRef) ---

	JSEvaluateScript :: proc(ctx: JSContextRef, script: JSStringRef, this_object: JSObjectRef, source_url: JSStringRef, starting_line_number: c.int, exception: ^JSValueRef) -> JSValueRef ---
	JSCheckScriptSyntax :: proc(ctx: JSContextRef, script: JSStringRef, source_url: JSStringRef, starting_line_number: c.int, exception: ^JSValueRef) -> bool ---
	JSGarbageCollect :: proc(ctx: JSContextRef) ---

	// GC protection — required to keep JS values (e.g. timer callbacks) alive
	// across event-loop turns while they are only referenced from native code.
	JSValueProtect :: proc(ctx: JSContextRef, value: JSValueRef) ---
	JSValueUnprotect :: proc(ctx: JSContextRef, value: JSValueRef) ---

	JSValueGetTypedArrayType :: proc(ctx: JSContextRef, value: JSValueRef, exception: ^JSValueRef) -> JSTypedArrayType ---
	JSObjectMakeTypedArrayWithBytesNoCopy :: proc(ctx: JSContextRef, array_type: JSTypedArrayType, bytes: rawptr, byte_length: c.size_t, byte_deallocator: proc "c" (bytes: rawptr, deallocator_context: rawptr), deallocator_context: rawptr, exception: ^JSValueRef) -> JSObjectRef ---
	JSObjectGetTypedArrayLength :: proc(ctx: JSContextRef, object: JSObjectRef, exception: ^JSValueRef) -> c.size_t ---
	JSObjectGetTypedArrayBytesPtr :: proc(ctx: JSContextRef, object: JSObjectRef, exception: ^JSValueRef) -> rawptr ---
	JSObjectGetTypedArrayByteLength :: proc(ctx: JSContextRef, object: JSObjectRef, exception: ^JSValueRef) -> c.size_t ---
	JSObjectGetTypedArrayByteOffset :: proc(ctx: JSContextRef, object: JSObjectRef, exception: ^JSValueRef) -> c.size_t ---
	JSObjectGetTypedArrayBuffer :: proc(ctx: JSContextRef, object: JSObjectRef, exception: ^JSValueRef) -> JSObjectRef ---

	JSObjectMakeArrayBufferWithBytesNoCopy :: proc(ctx: JSContextRef, bytes: rawptr, byte_length: c.size_t, byte_deallocator: proc "c" (bytes: rawptr, deallocator_context: rawptr), deallocator_context: rawptr, exception: ^JSValueRef) -> JSObjectRef ---
	JSObjectGetArrayBufferBytesPtr :: proc(ctx: JSContextRef, object: JSObjectRef, exception: ^JSValueRef) -> rawptr ---
	JSObjectGetArrayBufferByteLength :: proc(ctx: JSContextRef, object: JSObjectRef, exception: ^JSValueRef) -> c.size_t ---
}
