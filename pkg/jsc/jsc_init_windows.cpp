// Windows-only JavaScriptCore initialization shim.
//
// lava embeds JSC through the bare C API (JSGlobalContextCreate) and statically
// links the bun-webkit JavaScriptCore build. A dynamically-loaded JSC performs
// its one-time process bring-up via the OS loader; a statically-linked one never
// does, and the C API only lazily inits a minimal subset at first VM touch. The
// result on Windows is that JSC's JIT (executable-memory allocator, the
// concurrent-JIT worklist thread) and the parallel GC marker threads run on
// half-initialized engine state, which corrupts memory mid-execution under a
// heavy synchronous JS workload — surfacing as STATUS_STACK_BUFFER_OVERRUN
// (0xC0000409, reported by the test runner as exit 127). macOS/Linux are
// unaffected because the JSC there is a dylib that self-initializes.
//
// This is the same bring-up Bun (which ships the identical WebKit fork) performs
// before creating any VM: register the embedder's main thread, then run JSC's
// umbrella initialize() (Options finalize, JIT/GC threads, executable allocator,
// Config pages). Both calls are internally once-guarded and idempotent; we also
// guard the pair with std::call_once and run it on the process main thread before
// the first JSGlobalContextCreate. Keeping this correct lets us run FULL JIT.
//
// We FORWARD-DECLARE the two entry points rather than #include the WebKit C++
// headers: the bun-webkit release payload ships an incomplete internal header set
// (e.g. wtf/PlatformEnableWin.h is absent), and these functions are not in the
// public C API. Both are plain `void()` free functions in their namespaces, so
// these declarations mangle to exactly the symbols the static libs export
// (?initializeMainThread@WTF@@YAXXZ in WTF.lib, ?initialize@JSC@@YAXXZ in
// JavaScriptCore.lib) — no headers, no cmakeconfig/struct-layout concerns. If JSC
// ever renames or re-signatures these, the link fails loudly with the missing
// mangled symbol.
//
// Build: scripts/build-jsc-init-windows.sh compiles this with MSVC cl /MT (static
// CRT, matching the bun-webkit libs) into build/jsc_init.lib, put on the linker's
// LIB path; pkg/jsc imports the extern "C" entry below via `system:jsc_init.lib`.

#include <cstdlib>
#include <mutex>

namespace WTF {
	void initializeMainThread();
}

namespace JSC {
	void initialize();
}

extern "C" void lava_jsc_init(void) {
	static std::once_flag once;
	std::call_once(once, [] {
		// Disable the baseline JIT tier. That single tier is broken in this
		// bun-webkit Windows build in two ways, each of which corrupts memory
		// mid-execution (0xC0000409 / exit 127): its concurrent compilation races
		// the main thread (the node:url suite's crash), and its codegen for hot
		// numeric loops is wrong (the node:crypto/scrypt suite's crash). Disabling
		// just this tier fixes both while keeping the rest of the pipeline —
		// LLInt -> DFG -> FTL — so optimized JIT is retained (vastly better than
		// useJIT=false, which removes all JIT and itself destabilizes node:url).
		// Set via the CRT environment so JSC's Options finalize (inside initialize()
		// below) reads it through getenv; must be set BEFORE initialize().
		_putenv_s("JSC_useBaselineJIT", "false");

		WTF::initializeMainThread();
		JSC::initialize();
	});
}

// --- VM-entering Uint8Array creator ---
//
// JSC's typed-array C-API creators (JSObjectMakeTypedArray*) do NOT enter the VM
// (no JSLockHolder / APIEntryShim) — unlike JSObjectCallAsFunction et al., they
// assume the caller already holds the API lock. Native code that creates a
// Uint8Array from the bare event loop (fetch's streaming body is the first such
// caller) therefore runs with the wrong thread atom-string table; when the
// allocation triggers a GC, JSC::Heap::requestCollection aborts on
// RELEASE_ASSERT(vm().atomStringTable() == Thread::current().atomStringTable())
// — surfaced as 0xC0000409. Wrapping the creation in a JSLockHolder enters the VM
// (swapping in its atom-string table). JSLock is recursive, so callers already
// inside a JSC callback (fs/sqlite/crypto/buffer) re-enter harmlessly. This is the
// general guard for ALL native Uint8Array creation, so other modules cannot
// reintroduce the same crash.
//
// Forward-declared, like the init entry points above: JSLockHolder is exactly one
// pointer (RefPtr<VM> m_vm) with JS_EXPORT_PRIVATE ctor/dtor (plain symbols under
// BUN_JSC_ADDITIONS), and toJS(JSContextRef) is a reinterpret_cast to
// JSGlobalObject* (see JSC's APICast.h). kJSTypedArrayTypeUint8Array == 3.

extern "C" {
struct OpaqueJSContext;
struct OpaqueJSValue;
typedef const struct OpaqueJSContext *JSContextRef;
typedef const struct OpaqueJSValue *JSValueRef;
typedef struct OpaqueJSValue *JSObjectRef;
typedef void (*JSTypedArrayBytesDeallocator)(void *bytes, void *deallocatorContext);
JSObjectRef JSObjectMakeTypedArrayWithBytesNoCopy(JSContextRef ctx, int arrayType, void *bytes, size_t byteLength,
												  JSTypedArrayBytesDeallocator bytesDeallocator,
												  void *deallocatorContext, JSValueRef *exception);
}

namespace JSC {
	class JSGlobalObject;
	class JSLockHolder {
	public:
		JSLockHolder(JSGlobalObject *);
		~JSLockHolder();

	private:
		void *m_vm; // RefPtr<VM> — single pointer
	};
} // namespace JSC

extern "C" JSObjectRef lava_make_uint8_nocopy(JSContextRef ctx, void *bytes, size_t length,
											  JSTypedArrayBytesDeallocator dealloc) {
	JSC::JSLockHolder lock(reinterpret_cast<JSC::JSGlobalObject *>(const_cast<OpaqueJSContext *>(ctx)));
	return JSObjectMakeTypedArrayWithBytesNoCopy(ctx, 3 /* kJSTypedArrayTypeUint8Array */, bytes, length, dealloc,
												 nullptr, nullptr);
}
