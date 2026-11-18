package lava_runtime

import "core:encoding/json"
import "core:os"
import "core:path/filepath"
import "core:strings"
import jsc "lava:pkg/jsc"

// CommonJS resolver: relative/absolute specifiers resolve as a file (with extension
// probes) or as a directory (package.json "main" → index.*); a bare specifier walks
// up node_modules from `base_dir`. Returns a context.allocator-owned path the caller
// frees. (package.json "exports" conditional resolution is NOT yet supported.)
resolve_module_path :: proc(specifier: string, base_dir: string) -> (string, bool) {
	if resolved, ok := resolve_module_temp(specifier, base_dir); ok {
		// All internal resolution runs in the temp arena; clone the winner into the
		// caller-owned allocator (and canonicalize so redundant separators/symlinks
		// collapse to one module-cache key).
		canonical := resolved
		if abs_path, abs_err := filepath.abs(resolved, context.temp_allocator);
		   abs_err == os.ERROR_NONE && len(abs_path) > 0 {
			canonical = abs_path
		}
		owned, _ := strings.clone(canonical, context.allocator)
		return owned, true
	}
	return "", false
}

// resolve_module_temp does the resolution work entirely in the temp arena (paths it
// returns are temp-owned or borrowed from the inputs); resolve_module_path clones
// the result into the caller's allocator.
resolve_module_temp :: proc(specifier: string, base_dir: string) -> (string, bool) {
	is_relative := strings.has_prefix(specifier, "./") || strings.has_prefix(specifier, "../")
	when ODIN_OS == .Windows {
		if strings.has_prefix(specifier, ".\\") || strings.has_prefix(specifier, "..\\") {
			is_relative = true
		}
	}

	if is_relative || is_absolute_path(specifier) {
		base := specifier
		if !is_absolute_path(specifier) {
			dir := base_dir
			if len(dir) == 0 do dir = "."
			joined, join_err := filepath.join({dir, specifier}, context.temp_allocator)
			if join_err != nil do return "", false
			base = joined
		}
		cleaned, clean_err := filepath.clean(base, context.temp_allocator)
		if clean_err != nil do return "", false
		return resolve_file_or_directory(cleaned)
	}

	// Bare specifier (builtins are handled before resolve is reached): walk up the
	// directory tree trying <dir>/node_modules/<specifier> at each level.
	return resolve_node_modules(specifier, base_dir)
}

// resolve_file_or_directory tries `base` as a file (with extension probes) and, if
// it is a directory, via package.json "main" / index.*.
resolve_file_or_directory :: proc(base: string) -> (string, bool) {
	if resolved, ok := resolve_as_file(base); ok do return resolved, true
	if os.is_dir(base) do return resolve_as_directory(base)
	return "", false
}

// resolve_as_file returns `base` if it is a regular file, else the first hit of the
// extension probes. Probe order is Node's (.js, .json) then Lava's CJS/ESM extras.
resolve_as_file :: proc(base: string) -> (string, bool) {
	if module_resolvable_file(base) do return base, true
	for ext in ([?]string{".js", ".json", ".cjs", ".mjs"}) {
		with_ext := strings.concatenate({base, ext}, context.temp_allocator)
		if module_resolvable_file(with_ext) do return with_ext, true
	}
	return "", false
}

// resolve_as_directory resolves a directory module: package.json "main" first
// (itself resolved as a file or nested directory), then index.* in the directory.
resolve_as_directory :: proc(dir: string) -> (string, bool) {
	if main, ok := package_main(dir); ok {
		main_base, join_err := filepath.join({dir, main}, context.temp_allocator)
		if join_err == nil {
			cleaned, clean_err := filepath.clean(main_base, context.temp_allocator)
			if clean_err == nil {
				if resolved, ok2 := resolve_as_file(cleaned); ok2 do return resolved, true
				// "main" may point at a directory whose index.* is the entry.
				if os.is_dir(cleaned) {
					if resolved, ok3 := resolve_directory_index(cleaned); ok3 do return resolved, true
				}
			}
		}
		// Fall through to index.* when "main" is unresolvable (matches Node).
	}
	return resolve_directory_index(dir)
}

resolve_directory_index :: proc(dir: string) -> (string, bool) {
	index_base, join_err := filepath.join({dir, "index"}, context.temp_allocator)
	if join_err != nil do return "", false
	return resolve_as_file(index_base)
}

// resolve_node_modules walks up from base_dir, trying <dir>/node_modules/<specifier>
// (resolved as a file or directory) at each level until the filesystem root. Handles
// scoped (@scope/name) and subpath (pkg/lib/x) specifiers since they embed the
// separator that filepath.join preserves.
resolve_node_modules :: proc(specifier: string, base_dir: string) -> (string, bool) {
	if len(base_dir) == 0 do return "", false
	dir := base_dir
	for {
		target, join_err := filepath.join({dir, "node_modules", specifier}, context.temp_allocator)
		if join_err == nil {
			if resolved, ok := resolve_file_or_directory(target); ok do return resolved, true
		}
		parent := filepath.dir(dir)
		if parent == dir || len(parent) == 0 do break // reached the root
		dir = parent
	}
	return "", false
}

// package_main reads `dir`/package.json and returns its "main" field, if present and
// non-empty. (Only "main" is read; "exports" conditional resolution is unsupported.)
package_main :: proc(dir: string) -> (string, bool) {
	pkg_path, join_err := filepath.join({dir, "package.json"}, context.temp_allocator)
	if join_err != nil do return "", false
	data, read_err := os.read_entire_file(pkg_path, context.temp_allocator)
	if read_err != os.ERROR_NONE do return "", false

	Package :: struct {
		main: string,
	}
	pkg: Package
	if json.unmarshal(data, &pkg, json.DEFAULT_SPECIFICATION, context.temp_allocator) != nil {
		return "", false
	}
	if len(pkg.main) == 0 do return "", false
	return pkg.main, true
}

module_file_exists :: proc(path: string) -> bool {
	return os.exists(path)
}

// module_resolvable_file reports whether `path` is a regular file that can be
// loaded as a module. Unlike module_file_exists (used by fs.existsSync, which is
// true for directories), this excludes directories so a `lib/` directory does not
// shadow a sibling `lib.js` during require resolution.
module_resolvable_file :: proc(path: string) -> bool {
	return os.exists(path) && !os.is_dir(path)
}

// global_dirname reads the global __dirname (the entry file's directory). It is
// the resolution base for the entry's own require; required modules instead pass
// their own directory via their bound require (see native_require_cb). Returns
// (dir, allocated) — the caller frees `dir` when allocated.
global_dirname :: proc(ctx: jsc.JSContextRef) -> (string, bool) {
	global_obj := jsc.JSContextGetGlobalObject(ctx)
	key := jsc.JSStringCreateWithUTF8CString("__dirname")
	defer jsc.JSStringRelease(key)

	value := jsc.JSObjectGetProperty(ctx, global_obj, key, nil)
	return jsc_value_to_string_or_default(ctx, value)
}

// is_absolute_path classifies module specifiers during resolution. (node:path's
// own isAbsolute lives in js/node/path.js.)
is_absolute_path :: proc(path: string) -> bool {
	when ODIN_OS == .Windows {
		if len(path) == 0 do return false
		// Leading separator, including UNC paths (\\server\share) and '//'.
		if path[0] == '/' || path[0] == '\\' do return true
		// Drive-letter absolute path: 'C:\' or 'C:/'.
		if len(path) >= 3 && is_ascii_letter(path[0]) && path[1] == ':' && (path[2] == '/' || path[2] == '\\') {
			return true
		}
		return false
	} else {
		return strings.has_prefix(path, "/")
	}
}

is_ascii_letter :: proc(c: byte) -> bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}
