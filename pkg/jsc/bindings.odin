package jsc

import "core:c"

JSContextRef :: rawptr
JSGlobalContextRef :: JSContextRef

JSStringRef :: distinct rawptr
JSValueRef :: distinct rawptr
JSObjectRef :: distinct rawptr
JSClassRef :: distinct rawptr
// A context group is a JSC::VM: one GC heap, one lock, one microtask queue.
JSContextGroupRef :: distinct rawptr

// Called by the execution watchdog once a script has run past the group's limit.
// Return true to terminate it (it surfaces as an uncatchable termination exception).
JSShouldTerminateCallback :: #type proc "c" (ctx: JSContextRef, user_data: rawptr) -> bool

JSChar :: u16

JSType :: enum c.int {
	Undefined,
	Null,
	Boolean,
	Number,
	String,
	Object,
	Symbol,
}

// Order matches JavaScriptCore's JSTypedArrayType (JSTypedArray.h).
JSTypedArrayType :: enum c.int {
	Int8Array,
	Int16Array,
	Int32Array,
	Uint8Array,
	Uint8ClampedArray,
	Uint16Array,
	Uint32Array,
	Float32Array,
	Float64Array,
	ArrayBuffer,
	None,
}

JSClassAttributes :: enum c.uint {
	None                 = 0,
	NoAutomaticPrototype = 1 << 0,
}

JSPropertyAttribute :: enum c.uint {
	ReadOnly   = 1,
	DontEnum   = 2,
	DontDelete = 3,
}
JSPropertyAttributes :: bit_set[JSPropertyAttribute;c.uint]

JSObjectCallAsFunctionCallback :: proc "c" (
	ctx: JSContextRef,
	function: JSObjectRef,
	this_object: JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]JSValueRef,
	exception: ^JSValueRef,
) -> JSValueRef

JSObjectCallAsConstructorCallback :: proc "c" (
	ctx: JSContextRef,
	constructor: JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]JSValueRef,
	exception: ^JSValueRef,
) -> JSObjectRef

JSClassDefinition :: struct {
	version:             c.int,
	attributes:          JSClassAttributes,
	class_name:          cstring,
	parent_class:        JSClassRef,
	static_values:       ^JSStaticValue,
	static_functions:    ^JSStaticFunction,
	initialize:          proc "c" (ctx: JSContextRef, object: JSObjectRef),
	finalize:            proc "c" (object: JSObjectRef),
	has_property:        proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_name: JSStringRef,
	) -> b32,
	get_property:        proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_name: JSStringRef,
		exception: ^JSValueRef,
	) -> JSValueRef,
	set_property:        proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_name: JSStringRef,
		value: JSValueRef,
		exception: ^JSValueRef,
	) -> b32,
	delete_property:     proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_name: JSStringRef,
		exception: ^JSValueRef,
	) -> b32,
	get_property_names:  proc "c" (ctx: JSContextRef, object: JSObjectRef, property_names: rawptr),
	call_as_function:    JSObjectCallAsFunctionCallback,
	call_as_constructor: JSObjectCallAsConstructorCallback,
	has_instance:        proc "c" (
		ctx: JSContextRef,
		constructor: JSObjectRef,
		possible_instance: JSValueRef,
		exception: ^JSValueRef,
	) -> b32,
	convert_to_type:     proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		type: JSType,
		exception: ^JSValueRef,
	) -> JSValueRef,
}

JSStaticValue :: struct {
	name:         cstring,
	get_property: proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_name: JSStringRef,
		exception: ^JSValueRef,
	) -> JSValueRef,
	set_property: proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_name: JSStringRef,
		value: JSValueRef,
		exception: ^JSValueRef,
	) -> b32,
	attributes:   JSPropertyAttributes,
}

JSStaticFunction :: struct {
	name:             cstring,
	call_as_function: JSObjectCallAsFunctionCallback,
	attributes:       JSPropertyAttributes,
}
