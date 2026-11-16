// node:path — POSIX and Windows path algorithms, implemented in JS (as Node does)
// so the fiddly normalize / resolve / relative semantics match exactly. The native
// layer previously provided only basename/join/extname/isAbsolute; this supersedes
// it with the full common surface and both `posix` and `win32` variants. The
// exported `path` is the variant matching process.platform.
(function (require, module, _exports) {
  'use strict';

  // Captured for matchesGlob, which replaced two global-flag replaces. This file is not
  // otherwise hardened — see the ratchet baseline.
  var replaceCharAll = require('internal/primordials').replaceCharAll;

  var SLASH = 47; // '/'
  var BACKSLASH = 92; // '\'
  var DOT = 46; // '.'
  var COLON = 58; // ':'

  function isPosixSep(code) {
    return code === SLASH;
  }
  function isWin32Sep(code) {
    return code === SLASH || code === BACKSLASH;
  }
  function isWindowsDeviceRoot(code) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122); // A-Z a-z
  }

  function invalidArgType(name, expected, value) {
    var err = new TypeError(
      'The "' + name + '" argument must be of type ' + expected + '. Received type ' + typeof value,
    );
    err.code = 'ERR_INVALID_ARG_TYPE';
    return err;
  }

  function assertPath(path, name) {
    if (typeof path !== 'string') {
      throw invalidArgType(name || 'path', 'string', path);
    }
  }

  // Core of normalize/resolve: collapse `.` and `..` segments. `allowAboveRoot`
  // keeps leading `..` when the path is not absolute. Ported from the Node
  // algorithm so output matches byte-for-byte.
  function normalizeString(path, allowAboveRoot, separator, isSep) {
    var res = '';
    var lastSegmentLength = 0;
    var lastSlash = -1;
    var dots = 0;
    var code = 0;
    for (var i = 0; i <= path.length; ++i) {
      if (i < path.length) code = path.charCodeAt(i);
      else if (isSep(code)) break;
      else code = SLASH;

      if (isSep(code)) {
        if (lastSlash === i - 1 || dots === 1) {
          // empty segment or '.', skip
        } else if (dots === 2) {
          if (
            res.length < 2 ||
            lastSegmentLength !== 2 ||
            res.charCodeAt(res.length - 1) !== DOT ||
            res.charCodeAt(res.length - 2) !== DOT
          ) {
            if (res.length > 2) {
              var lastSep = res.lastIndexOf(separator);
              if (lastSep === -1) {
                res = '';
                lastSegmentLength = 0;
              } else {
                res = res.slice(0, lastSep);
                lastSegmentLength = res.length - 1 - res.lastIndexOf(separator);
              }
              lastSlash = i;
              dots = 0;
              continue;
            } else if (res.length > 0) {
              res = '';
              lastSegmentLength = 0;
              lastSlash = i;
              dots = 0;
              continue;
            }
          }
          if (allowAboveRoot) {
            res += res.length > 0 ? separator + '..' : '..';
            lastSegmentLength = 2;
          }
        } else {
          if (res.length > 0) res += separator + path.slice(lastSlash + 1, i);
          else res = path.slice(lastSlash + 1, i);
          lastSegmentLength = i - lastSlash - 1;
        }
        lastSlash = i;
        dots = 0;
      } else if (code === DOT && dots !== -1) {
        ++dots;
      } else {
        dots = -1;
      }
    }
    return res;
  }

  function formatExt(ext) {
    return ext ? (ext[0] === '.' ? ext : '.' + ext) : '';
  }

  // _format builds a path from a { dir, root, base, name, ext } object.
  function makeFormat(sep) {
    return function format(pathObject) {
      if (pathObject === null || typeof pathObject !== 'object') {
        throw new TypeError(
          'The "pathObject" argument must be of type object. Received ' + typeof pathObject,
        );
      }
      var dir = pathObject.dir || pathObject.root;
      var base = pathObject.base || (pathObject.name || '') + formatExt(pathObject.ext);
      if (!dir) return base;
      return dir === pathObject.root ? dir + base : dir + sep + base;
    };
  }

  // --- POSIX ---
  var posix = {
    sep: '/',
    delimiter: ':',

    resolve: function resolve() {
      var resolvedPath = '';
      var resolvedAbsolute = false;
      for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
        var path = i >= 0 ? arguments[i] : posixCwd();
        assertPath(path);
        if (path.length === 0) continue;
        resolvedPath = path + '/' + resolvedPath;
        resolvedAbsolute = path.charCodeAt(0) === SLASH;
      }
      resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute, '/', isPosixSep);
      if (resolvedAbsolute) return '/' + resolvedPath;
      return resolvedPath.length > 0 ? resolvedPath : '.';
    },

    normalize: function normalize(path) {
      assertPath(path);
      if (path.length === 0) return '.';
      var isAbsolute = path.charCodeAt(0) === SLASH;
      var trailingSeparator = path.charCodeAt(path.length - 1) === SLASH;
      path = normalizeString(path, !isAbsolute, '/', isPosixSep);
      if (path.length === 0) {
        if (isAbsolute) return '/';
        return trailingSeparator ? './' : '.';
      }
      if (trailingSeparator) path += '/';
      return isAbsolute ? '/' + path : path;
    },

    isAbsolute: function isAbsolute(path) {
      assertPath(path);
      return path.length > 0 && path.charCodeAt(0) === SLASH;
    },

    join: function join() {
      if (arguments.length === 0) return '.';
      var joined;
      for (var i = 0; i < arguments.length; ++i) {
        var arg = arguments[i];
        assertPath(arg);
        if (arg.length > 0) {
          if (joined === undefined) joined = arg;
          else joined += '/' + arg;
        }
      }
      if (joined === undefined) return '.';
      return posix.normalize(joined);
    },

    relative: function relative(from, to) {
      assertPath(from, 'from');
      assertPath(to, 'to');
      if (from === to) return '';
      from = posix.resolve(from);
      to = posix.resolve(to);
      if (from === to) return '';
      return computeRelative(from, to, '/', SLASH);
    },

    dirname: function dirname(path) {
      assertPath(path);
      if (path.length === 0) return '.';
      var hasRoot = path.charCodeAt(0) === SLASH;
      var end = -1;
      var matchedSlash = true;
      for (var i = path.length - 1; i >= 1; --i) {
        if (path.charCodeAt(i) === SLASH) {
          if (!matchedSlash) {
            end = i;
            break;
          }
        } else {
          matchedSlash = false;
        }
      }
      if (end === -1) return hasRoot ? '/' : '.';
      if (hasRoot && end === 1) return '//';
      return path.slice(0, end);
    },

    basename: function basename(path, suffix) {
      if (suffix !== undefined && typeof suffix !== 'string') {
        throw invalidArgType('suffix', 'string', suffix);
      }
      assertPath(path);
      return computeBasename(path, suffix, isPosixSep);
    },

    extname: function extname(path) {
      assertPath(path);
      return computeExtname(path, isPosixSep);
    },

    parse: function parse(path) {
      assertPath(path);
      return computeParse(path, '/', SLASH, isPosixSep);
    },

    toNamespacedPath: function toNamespacedPath(path) {
      return path;
    },
  };
  posix.format = makeFormat('/');

  function posixCwd() {
    return typeof process !== 'undefined' && process.cwd ? process.cwd() : '/';
  }

  // --- Win32 ---
  // A pragmatic port: full normalize/join/relative/dirname/basename/extname plus
  // drive/UNC-aware isAbsolute. resolve falls back to the process cwd for
  // drive-relative inputs rather than consulting per-drive working directories.
  var win32 = {
    sep: '\\',
    delimiter: ';',

    resolve: function resolve() {
      var resolvedDevice = '';
      var resolvedTail = '';
      var resolvedAbsolute = false;
      for (var i = arguments.length - 1; i >= -1; i--) {
        var path;
        if (i >= 0) {
          path = arguments[i];
          assertPath(path);
          if (path.length === 0) continue;
        } else if (resolvedDevice.length === 0) {
          path = win32Cwd();
        } else {
          path = win32Cwd();
          if (
            path === undefined ||
            (path.slice(0, 2).toLowerCase() !== resolvedDevice.toLowerCase() &&
              path.charCodeAt(2) === BACKSLASH)
          ) {
            path = resolvedDevice + '\\';
          }
        }

        var len = path.length;
        var rootEnd = 0;
        var device = '';
        var isAbsolute = false;
        var code = path.charCodeAt(0);

        if (len === 1) {
          if (isWin32Sep(code)) {
            rootEnd = 1;
            isAbsolute = true;
          }
        } else if (isWin32Sep(code)) {
          isAbsolute = true;
          if (isWin32Sep(path.charCodeAt(1))) {
            // UNC: \\server\share
            var j = 2;
            var last = j;
            while (j < len && !isWin32Sep(path.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              var firstPart = path.slice(last, j);
              last = j;
              while (j < len && isWin32Sep(path.charCodeAt(j))) j++;
              if (j < len && j !== last) {
                last = j;
                while (j < len && !isWin32Sep(path.charCodeAt(j))) j++;
                if (j === len || j !== last) {
                  device = '\\\\' + firstPart + '\\' + path.slice(last, j);
                  rootEnd = j;
                }
              }
            }
          } else {
            rootEnd = 1;
          }
        } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === COLON) {
          device = path.slice(0, 2);
          rootEnd = 2;
          if (len > 2 && isWin32Sep(path.charCodeAt(2))) {
            isAbsolute = true;
            rootEnd = 3;
          }
        }

        if (device.length > 0) {
          if (resolvedDevice.length > 0) {
            if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue;
          } else {
            resolvedDevice = device;
          }
        }

        if (resolvedAbsolute) {
          if (resolvedDevice.length > 0) break;
        } else {
          resolvedTail = path.slice(rootEnd) + '\\' + resolvedTail;
          resolvedAbsolute = isAbsolute;
          if (isAbsolute && resolvedDevice.length > 0) break;
        }
      }

      resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute, '\\', isWin32Sep);
      return resolvedAbsolute
        ? resolvedDevice + '\\' + resolvedTail
        : resolvedDevice + resolvedTail || '.';
    },

    normalize: function normalize(path) {
      assertPath(path);
      var len = path.length;
      if (len === 0) return '.';
      var rootEnd = 0;
      var device;
      var isAbsolute = false;
      var code = path.charCodeAt(0);

      if (len === 1) {
        return isPosixSep(code) ? '\\' : path;
      }
      if (isWin32Sep(code)) {
        isAbsolute = true;
        if (isWin32Sep(path.charCodeAt(1))) {
          var j = 2;
          var last = j;
          while (j < len && !isWin32Sep(path.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            var firstPart = path.slice(last, j);
            last = j;
            while (j < len && isWin32Sep(path.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              last = j;
              while (j < len && !isWin32Sep(path.charCodeAt(j))) j++;
              if (j === len) return '\\\\' + firstPart + '\\' + path.slice(last) + '\\';
              if (j !== last) {
                device = '\\\\' + firstPart + '\\' + path.slice(last, j);
                rootEnd = j;
              }
            }
          }
        } else {
          rootEnd = 1;
        }
      } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === COLON) {
        device = path.slice(0, 2);
        rootEnd = 2;
        if (len > 2 && isWin32Sep(path.charCodeAt(2))) {
          isAbsolute = true;
          rootEnd = 3;
        }
      }

      var tail =
        rootEnd < len ? normalizeString(path.slice(rootEnd), !isAbsolute, '\\', isWin32Sep) : '';
      if (tail.length === 0 && !isAbsolute) tail = '.';
      if (tail.length > 0 && isWin32Sep(path.charCodeAt(len - 1))) tail += '\\';
      if (device === undefined) {
        return isAbsolute ? '\\' + tail : tail;
      }
      return isAbsolute ? device + '\\' + tail : device + tail;
    },

    isAbsolute: function isAbsolute(path) {
      assertPath(path);
      var len = path.length;
      if (len === 0) return false;
      var code = path.charCodeAt(0);
      if (isWin32Sep(code)) return true;
      if (isWindowsDeviceRoot(code) && len > 2 && path.charCodeAt(1) === COLON) {
        return isWin32Sep(path.charCodeAt(2));
      }
      return false;
    },

    join: function join() {
      if (arguments.length === 0) return '.';
      var joined;
      var firstPart;
      for (var i = 0; i < arguments.length; ++i) {
        var arg = arguments[i];
        assertPath(arg);
        if (arg.length > 0) {
          if (joined === undefined) joined = firstPart = arg;
          else joined += '\\' + arg;
        }
      }
      if (joined === undefined) return '.';
      // Preserve a leading UNC root: collapse only the extra leading separators.
      var needsReplace = true;
      var slashCount = 0;
      if (isWin32Sep(firstPart.charCodeAt(0))) {
        ++slashCount;
        var fLen = firstPart.length;
        if (fLen > 1 && isWin32Sep(firstPart.charCodeAt(1))) {
          ++slashCount;
          if (fLen > 2) {
            if (isWin32Sep(firstPart.charCodeAt(2))) ++slashCount;
            else needsReplace = false;
          }
        }
      }
      if (needsReplace) {
        while (slashCount < joined.length && isWin32Sep(joined.charCodeAt(slashCount)))
          slashCount++;
        if (slashCount >= 2) joined = '\\' + joined.slice(slashCount);
      }
      return win32.normalize(joined);
    },

    relative: function relative(from, to) {
      assertPath(from, 'from');
      assertPath(to, 'to');
      if (from === to) return '';
      var fromOrig = win32.resolve(from);
      var toOrig = win32.resolve(to);
      if (fromOrig === toOrig) return '';
      var fromLower = fromOrig.toLowerCase();
      var toLower = toOrig.toLowerCase();
      if (fromLower === toLower) return '';
      return computeWin32Relative(fromOrig, toOrig, fromLower, toLower);
    },

    dirname: function dirname(path) {
      assertPath(path);
      var len = path.length;
      if (len === 0) return '.';
      var rootEnd = -1;
      var offset = 0;
      var code = path.charCodeAt(0);
      if (len === 1) return isWin32Sep(code) ? path : '.';
      if (isWin32Sep(code)) {
        rootEnd = offset = 1;
        if (isWin32Sep(path.charCodeAt(1))) {
          var j = 2;
          var last = j;
          while (j < len && !isWin32Sep(path.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && isWin32Sep(path.charCodeAt(j))) j++;
            if (j < len && j !== last) {
              last = j;
              while (j < len && !isWin32Sep(path.charCodeAt(j))) j++;
              if (j === len) return path;
              if (j !== last) rootEnd = offset = j + 1;
            }
          }
        }
      } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === COLON) {
        rootEnd = offset = len > 2 && isWin32Sep(path.charCodeAt(2)) ? 3 : 2;
      }
      var end = -1;
      var matchedSlash = true;
      for (var i = len - 1; i >= offset; --i) {
        if (isWin32Sep(path.charCodeAt(i))) {
          if (!matchedSlash) {
            end = i;
            break;
          }
        } else {
          matchedSlash = false;
        }
      }
      if (end === -1) {
        if (rootEnd === -1) return '.';
        end = rootEnd;
      }
      return path.slice(0, end);
    },

    basename: function basename(path, suffix) {
      if (suffix !== undefined && typeof suffix !== 'string') {
        throw invalidArgType('suffix', 'string', suffix);
      }
      assertPath(path);
      var start = 0;
      if (
        path.length >= 2 &&
        isWindowsDeviceRoot(path.charCodeAt(0)) &&
        path.charCodeAt(1) === COLON
      ) {
        start = 2;
      }
      return computeBasename(path, suffix, isWin32Sep, start);
    },

    extname: function extname(path) {
      assertPath(path);
      var start = 0;
      if (
        path.length >= 2 &&
        isWindowsDeviceRoot(path.charCodeAt(0)) &&
        path.charCodeAt(1) === COLON
      ) {
        start = 2;
      }
      return computeExtname(path, isWin32Sep, start);
    },

    parse: function parse(path) {
      assertPath(path);
      return computeParse(path, '\\', BACKSLASH, isWin32Sep);
    },

    toNamespacedPath: function toNamespacedPath(path) {
      if (typeof path !== 'string' || path.length === 0) return path;
      var resolved = win32.resolve(path);
      if (resolved.length <= 2) return path;
      if (resolved.charCodeAt(0) === BACKSLASH) {
        if (resolved.charCodeAt(1) === BACKSLASH) {
          var code = resolved.charCodeAt(2);
          if (code !== 63 && code !== 46) {
            return '\\\\?\\UNC\\' + resolved.slice(2);
          }
        }
      } else if (
        isWindowsDeviceRoot(resolved.charCodeAt(0)) &&
        resolved.charCodeAt(1) === COLON &&
        resolved.charCodeAt(2) === BACKSLASH
      ) {
        return '\\\\?\\' + resolved;
      }
      return path;
    },
  };
  win32.format = makeFormat('\\');

  function win32Cwd() {
    return typeof process !== 'undefined' && process.cwd ? process.cwd() : 'C:\\';
  }

  // --- shared helpers used by both variants ---

  function computeRelative(from, to, sep, sepCode, fromLowerOpt, toLowerOpt) {
    var fromLower = fromLowerOpt !== undefined ? fromLowerOpt : from;
    var toLower = toLowerOpt !== undefined ? toLowerOpt : to;

    var fromStart = 1;
    while (fromStart < from.length && from.charCodeAt(fromStart) === sepCode) fromStart++;
    var fromEnd = from.length;
    var fromLen = fromEnd - fromStart;

    var toStart = 1;
    while (toStart < to.length && to.charCodeAt(toStart) === sepCode) toStart++;
    var toEnd = to.length;
    var toLen = toEnd - toStart;

    var length = fromLen < toLen ? fromLen : toLen;
    var lastCommonSep = -1;
    var i = 0;
    for (; i < length; i++) {
      var fc = fromLower.charCodeAt(fromStart + i);
      if (fc !== toLower.charCodeAt(toStart + i)) break;
      if (fc === sepCode) lastCommonSep = i;
    }
    if (i === length) {
      if (toLen > length) {
        if (toLower.charCodeAt(toStart + i) === sepCode) return to.slice(toStart + i + 1);
        if (i === 0) return to.slice(toStart + i);
      } else if (fromLen > length) {
        if (fromLower.charCodeAt(fromStart + i) === sepCode) lastCommonSep = i;
        else if (i === 0) lastCommonSep = 0;
      }
    }

    var out = '';
    for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
      if (i === fromEnd || from.charCodeAt(i) === sepCode) {
        out += out.length === 0 ? '..' : sep + '..';
      }
    }
    return out + to.slice(toStart + lastCommonSep);
  }

  function computeWin32Relative(fromOrig, toOrig, fromLower, toLower) {
    var fromStart = 0;
    while (fromStart < fromLower.length && fromLower.charCodeAt(fromStart) === BACKSLASH) {
      fromStart++;
    }
    var fromEnd = fromLower.length;
    while (fromEnd - 1 > fromStart && fromLower.charCodeAt(fromEnd - 1) === BACKSLASH) {
      fromEnd--;
    }
    var fromLen = fromEnd - fromStart;

    var toStart = 0;
    while (toStart < toLower.length && toLower.charCodeAt(toStart) === BACKSLASH) {
      toStart++;
    }
    var toEnd = toLower.length;
    while (toEnd - 1 > toStart && toLower.charCodeAt(toEnd - 1) === BACKSLASH) {
      toEnd--;
    }
    var toLen = toEnd - toStart;

    var length = fromLen < toLen ? fromLen : toLen;
    var lastCommonSep = -1;
    var i = 0;
    for (; i < length; i++) {
      var fc = fromLower.charCodeAt(fromStart + i);
      if (fc !== toLower.charCodeAt(toStart + i)) break;
      if (fc === BACKSLASH) lastCommonSep = i;
    }

    if (i !== length) {
      if (lastCommonSep === -1) return toOrig;
    } else {
      if (toLen > length) {
        if (toLower.charCodeAt(toStart + i) === BACKSLASH) {
          return toOrig.slice(toStart + i + 1, toEnd);
        }
        if (i === 2) return toOrig.slice(toStart + i, toEnd);
      }
      if (fromLen > length) {
        if (fromLower.charCodeAt(fromStart + i) === BACKSLASH) {
          lastCommonSep = i;
        } else if (i === 2) {
          lastCommonSep = 3;
        }
      }
      if (lastCommonSep === -1) lastCommonSep = 0;
    }

    var out = '';
    for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
      if (i === fromEnd || fromOrig.charCodeAt(i) === BACKSLASH) {
        out += out.length === 0 ? '..' : '\\..';
      }
    }

    toStart += lastCommonSep;
    if (out.length > 0) return out + toOrig.slice(toStart, toEnd);
    if (toOrig.charCodeAt(toStart) === BACKSLASH) ++toStart;
    return toOrig.slice(toStart, toEnd);
  }

  function computeBasename(path, suffix, isSep, start) {
    start = start || 0;
    var end = -1;
    var matchedSlash = true;
    var i;
    if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
      if (suffix === path) return '';
      var extIdx = suffix.length - 1;
      var firstNonSlashEnd = -1;
      for (i = path.length - 1; i >= start; --i) {
        var code = path.charCodeAt(i);
        if (isSep(code)) {
          if (!matchedSlash) {
            start = i + 1;
            break;
          }
        } else {
          if (firstNonSlashEnd === -1) {
            matchedSlash = false;
            firstNonSlashEnd = i + 1;
          }
          if (extIdx >= 0) {
            if (code === suffix.charCodeAt(extIdx)) {
              if (--extIdx === -1) end = i;
            } else {
              extIdx = -1;
              end = firstNonSlashEnd;
            }
          }
        }
      }
      if (start === end) end = firstNonSlashEnd;
      else if (end === -1) end = path.length;
      return path.slice(start, end);
    }
    for (i = path.length - 1; i >= start; --i) {
      if (isSep(path.charCodeAt(i))) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
    }
    if (end === -1) return '';
    return path.slice(start, end);
  }

  function computeExtname(path, isSep, start) {
    start = start || 0;
    var startDot = -1;
    var startPart = start;
    var end = -1;
    var matchedSlash = true;
    var preDotState = 0;
    for (var i = path.length - 1; i >= start; --i) {
      var code = path.charCodeAt(i);
      if (isSep(code)) {
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
      if (code === DOT) {
        if (startDot === -1) startDot = i;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) {
        preDotState = -1;
      }
    }
    if (
      startDot === -1 ||
      end === -1 ||
      preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
    ) {
      return '';
    }
    return path.slice(startDot, end);
  }

  function computeParse(path, sep, sepCode, isSep) {
    var ret = { root: '', dir: '', base: '', ext: '', name: '' };
    if (path.length === 0) return ret;
    var win = sepCode === BACKSLASH;
    var isAbsolute;
    var start; // loop lower bound (past the root)
    var rootEnd = 0;
    if (win) {
      rootEnd = parseWin32Root(path);
      ret.root = path.slice(0, rootEnd);
      start = rootEnd;
      isAbsolute = rootEnd > 0 && isSep(path.charCodeAt(rootEnd - 1));
    } else {
      isAbsolute = path.charCodeAt(0) === sepCode;
      if (isAbsolute) {
        ret.root = sep;
        start = 1;
      } else {
        start = 0;
      }
    }

    var startDot = -1;
    // POSIX seeds startPart at 0 (with a +1 base adjustment for absolute paths);
    // Win32 seeds it at the root end. Matches Node so `.`/`..` split identically.
    var startPart = win ? rootEnd : 0;
    var end = -1;
    var matchedSlash = true;
    var preDotState = 0;
    for (var i = path.length - 1; i >= start; --i) {
      var code = path.charCodeAt(i);
      if (isSep(code)) {
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
      if (end === -1) {
        matchedSlash = false;
        end = i + 1;
      }
      if (code === DOT) {
        if (startDot === -1) startDot = i;
        else if (preDotState !== 1) preDotState = 1;
      } else if (startDot !== -1) {
        preDotState = -1;
      }
    }

    if (end !== -1) {
      var s = !win && startPart === 0 && isAbsolute ? 1 : startPart;
      if (
        startDot === -1 ||
        preDotState === 0 ||
        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
      ) {
        ret.base = ret.name = path.slice(s, end);
      } else {
        ret.name = path.slice(s, startDot);
        ret.base = path.slice(s, end);
        ret.ext = path.slice(startDot, end);
      }
    }

    if (win) {
      if (startPart > 0 && startPart !== rootEnd) ret.dir = path.slice(0, startPart - 1);
      else ret.dir = ret.root;
    } else {
      if (startPart > 0) ret.dir = path.slice(0, startPart - 1);
      else if (isAbsolute) ret.dir = sep;
    }
    return ret;
  }

  function parseWin32Root(path) {
    var len = path.length;
    var code = path.charCodeAt(0);
    if (isWin32Sep(code)) {
      if (len > 1 && isWin32Sep(path.charCodeAt(1))) {
        var j = 2;
        var last = j;
        while (j < len && !isWin32Sep(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && isWin32Sep(path.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && !isWin32Sep(path.charCodeAt(j))) j++;
            // Include the trailing separator after the share in the root
            // (\\server\share\dir -> root "\\server\share\").
            if (j === len) return j;
            if (j !== last) return j + 1;
          }
        }
      }
      return 1;
    }
    if (isWindowsDeviceRoot(code) && len > 1 && path.charCodeAt(1) === COLON) {
      if (len > 2 && isWin32Sep(path.charCodeAt(2))) return 3;
      return 2;
    }
    return 0;
  }

  // --- matchesGlob (Node 22.5+) ---
  // A glob matcher with the same surface as Node's path.matchesGlob (which delegates to its
  // bundled minimatch): `*`/`?` match within one segment and not a leading dot; `**` spans
  // segments (stopping at a dotfile); `{a,b}` and `{1..3}`/`{a..c}` expand; `[abc]`/`[!abc]`
  // and POSIX `[[:alpha:]]` classes; an invalid range matches nothing; `\` is a path
  // separator (windowsPathsNoEscape), and on the win32 variant a `\` in the path is one too;
  // `.`/`..` segments are resolved; a leading `/` is absolute and a trailing `/` marks a
  // directory. Case-insensitive on Windows and macOS, like Node. Extended-glob operators
  // (`@(...)`, `+(...)`, etc.) are not yet supported (tracked separately).
  var GLOB_NOCASE =
    typeof process !== 'undefined' &&
    (process.platform === 'win32' || process.platform === 'darwin');
  var GLOB_RE_SPECIAL = /[.*+?^${}()|[\]\\]/;
  // The POSIX classes Node's matcher recognizes, as Unicode-property sets (so they match
  // non-ASCII letters/punctuation exactly like Node). A `\p{}` escape forces the regex `u`
  // flag (see globSegToRegex). Notes: `punct` is `\p{P}` (so the math symbols `$+<=>^\`|~`,
  // which are `\p{S}`, are excluded while `.` and `-` are included), and `print` maps to the
  // control set like `cntrl` — a minimatch quirk, not the printable range.
  var GLOB_POSIX_CLASSES = {
    alpha: '\\p{L}\\p{Nl}',
    digit: '\\p{Nd}',
    alnum: '\\p{L}\\p{Nl}\\p{Nd}',
    upper: '\\p{Lu}',
    lower: '\\p{Ll}',
    space: '\\s',
    blank: '\\p{Zs}\\t',
    word: '\\p{L}\\p{Nl}\\p{Nd}_',
    ascii: '\\x00-\\x7f',
    xdigit: '0-9A-Fa-f',
    punct: '\\p{P}',
    graph: '\\p{L}\\p{N}\\p{P}\\p{S}\\p{M}',
    cntrl: '\\p{Cc}',
    print: '\\p{Cc}',
  };

  function globEscape(ch) {
    return GLOB_RE_SPECIAL.test(ch) ? '\\' + ch : ch;
  }

  // Parse a `[...]` class at `start`; returns {re, next, dot} (dot = matches a literal '.')
  // or null when unterminated.
  function globParseClass(seg, start) {
    var j = start + 1;
    var neg = false;
    if (seg[j] === '!' || seg[j] === '^') {
      neg = true;
      j++;
    }
    var cls = '';
    var dot = false;
    if (seg[j] === ']') {
      cls += '\\]';
      j++;
    }
    while (j < seg.length && seg[j] !== ']') {
      if (seg[j] === '[' && seg[j + 1] === ':') {
        var end = seg.indexOf(':]', j + 2);
        if (end !== -1) {
          var name = seg.slice(j + 2, end);
          if (GLOB_POSIX_CLASSES[name]) {
            cls += GLOB_POSIX_CLASSES[name];
            j = end + 2;
            continue;
          }
        }
      }
      var cc = seg[j];
      if (cc === '.') dot = true;
      if (cc === '\\') {
        cls += '\\' + (seg[j + 1] || '');
        j += 2;
      } else if (cc === '^' || cc === '[') {
        cls += '\\' + cc;
        j++;
      } else {
        cls += cc;
        j++;
      }
    }
    if (j >= seg.length) return null;
    return { re: '[' + (neg ? '^' : '') + cls + ']', next: j + 1, dot: !neg && dot };
  }

  // Is `ch` an extended-glob operator (introduces a group when followed by '(')?
  function globIsExtOp(ch) {
    return ch === '@' || ch === '+' || ch === '!' || ch === '*' || ch === '?';
  }

  // Index of the ')' closing an extglob group whose '(' is at `open`. Only a '(' that
  // follows an extglob operator opens a nested group; a bare '(' is a literal character,
  // and []-class contents are skipped. Returns -1 if unterminated.
  function globExtglobEnd(seg, open) {
    var depth = 0;
    for (var j = open; j < seg.length; j++) {
      var c = seg[j];
      if (c === '[') {
        var pc = globParseClass(seg, j);
        if (pc !== null) {
          j = pc.next - 1;
          continue;
        }
      } else if (c === '(' && (j === open || globIsExtOp(seg[j - 1]))) {
        depth++;
      } else if (c === ')') {
        depth--;
        if (depth <= 0) return j;
      }
    }
    return -1;
  }

  // Split a group body on top-level '|' (not inside nested groups or classes).
  function globSplitAlts(body) {
    var alts = [];
    var start = 0;
    var depth = 0;
    for (var j = 0; j < body.length; j++) {
      var c = body[j];
      if (c === '[') {
        var pc = globParseClass(body, j);
        if (pc !== null) {
          j = pc.next - 1;
          continue;
        }
      } else if (c === '(' && j > 0 && globIsExtOp(body[j - 1])) {
        depth++;
      } else if (c === ')') {
        if (depth > 0) depth--;
      } else if (c === '|' && depth === 0) {
        alts.push(body.slice(start, j));
        start = j + 1;
      }
    }
    alts.push(body.slice(start));
    return alts;
  }

  // Compile the `|`-separated alternatives of an extglob group. Returns {re, dot} where an
  // alternative containing an invalid range becomes a never-match (Node keeps the others),
  // and dot reports whether any alternative can start with a literal '.'.
  function globCompileAlts(body) {
    var alts = globSplitAlts(body);
    var parts = [];
    var dot = false;
    var nullable = false;
    for (var a = 0; a < alts.length; a++) {
      if (alts[a] === '') nullable = true; // an empty alternative can match nothing
      var compiled = globCompileBody(alts[a]);
      var b = compiled.body;
      try {
        new RegExp('^(?:' + b + ')$');
      } catch {
        b = '(?!)'; // an invalid alternative matches nothing; the others still apply
      }
      parts.push(b);
      if (compiled.firstDot) dot = true;
    }
    return { re: parts.join('|'), dot: dot, nullable: nullable };
  }

  // Compile a segment glob to a regex body (no anchors). Returns {body, firstDot} where
  // firstDot reports whether the first atom can match a leading '.' — a nullable extglob
  // (`?(...)`, `*(...)`, or `@()`/`+()` with an empty alternative) lets the following atom
  // decide, while a plain `*`/`?` fixes "no leading dot".
  function globCompileBody(seg) {
    var re = '';
    var i = 0;
    var firstDot = false;
    var firstLocked = false;
    function lockFirst(dotMatch, seeThrough) {
      if (firstLocked) return;
      if (dotMatch) {
        firstDot = true;
        firstLocked = true;
      } else if (!seeThrough) {
        firstLocked = true;
      }
    }
    while (i < seg.length) {
      var c = seg[i];
      if (globIsExtOp(c) && seg[i + 1] === '(') {
        var end = globExtglobEnd(seg, i + 1);
        if (end !== -1) {
          var alts = globCompileAlts(seg.slice(i + 2, end));
          if (c === '!') {
            // `!(...)` negates the whole remainder of the segment: consume the suffix and
            // forbid (alternatives + suffix) from being the entire remaining text.
            var suffix = globCompileBody(seg.slice(end + 1));
            re += '(?!(?:' + alts.re + ')(?:' + suffix.body + ')$)[^/]*?' + suffix.body;
            lockFirst(false, false);
            return { body: re, firstDot: firstDot };
          }
          var quant = c === '+' ? '+' : c === '*' ? '*' : c === '?' ? '?' : '';
          re += '(?:' + alts.re + ')' + quant;
          lockFirst(alts.dot, c === '?' || c === '*' || alts.nullable);
          i = end + 1;
          continue;
        }
      }
      if (c === '*') {
        re += '[^/]*';
        lockFirst(false, false);
        i++;
      } else if (c === '?') {
        re += '[^/]';
        lockFirst(false, false);
        i++;
      } else if (c === '[') {
        var parsed = globParseClass(seg, i);
        if (parsed === null) {
          re += '\\[';
          lockFirst(false, false);
          i++;
        } else {
          re += parsed.re;
          lockFirst(parsed.dot, false);
          i = parsed.next;
        }
      } else {
        re += globEscape(c);
        lockFirst(c === '.', false);
        i++;
      }
    }
    return { body: re, firstDot: firstDot };
  }

  // Whether a whole segment is a zero-length-capable extglob (`*(...)`, `?(...)`, `!(...)`)
  // — the segments that match an empty path in Node.
  function globNullable(seg) {
    if (seg.length < 3 || (seg[0] !== '*' && seg[0] !== '?' && seg[0] !== '!') || seg[1] !== '(') {
      return false;
    }
    return globExtglobEnd(seg, 1) === seg.length - 1;
  }

  // A segment is "magic" — and so matched case-insensitively on Windows/macOS, like Node —
  // when it has a wildcard, an extglob, or a real character class. A purely literal segment
  // (or a single positive char class like `[a]`, which minimatch treats as a literal) is
  // matched case-sensitively even there, so `ABC` does not match `abc`.
  function globSegHasMagic(seg) {
    for (var i = 0; i < seg.length; i++) {
      var c = seg[i];
      if (c === '*' || c === '?') return true;
      if (globIsExtOp(c) && seg[i + 1] === '(') return true;
      if (c === '[') {
        var pc = globParseClass(seg, i);
        if (pc !== null) {
          // ranges, negation, POSIX classes and multi-char sets are magic; `[a]` is not.
          if (!/^[^!^]$/.test(seg.slice(i + 1, pc.next - 1))) return true;
          i = pc.next - 1;
        }
      }
    }
    return false;
  }

  function globSegToRegex(seg) {
    var compiled = globCompileBody(seg);
    var re = compiled.body;
    // A wildcard at the start of a segment must not match a leading dot (dot:false).
    if (!compiled.firstDot) re = '(?!\\.)' + re;
    var flags = '';
    if (GLOB_NOCASE && globSegHasMagic(seg)) flags += 'i';
    if (re.indexOf('\\p{') !== -1) flags += 'u'; // `[[:word:]]` expands to a Unicode property
    try {
      return new RegExp('^' + re + '$', flags);
    } catch {
      return /(?!)/; // an invalid range matches nothing, like Node
    }
  }

  function globMatchSegs(patSegs, pathSegs, pi, si, trail) {
    while (pi < patSegs.length) {
      if (patSegs[pi] === '**') {
        if (pi + 1 === patSegs.length) {
          if (si >= pathSegs.length) return pi === 0 || trail;
          for (var k = si; k < pathSegs.length; k++) {
            if (pathSegs[k][0] === '.') return false;
          }
          return true;
        }
        if (globMatchSegs(patSegs, pathSegs, pi + 1, si, trail)) return true;
        while (si < pathSegs.length) {
          if (pathSegs[si][0] === '.') return false;
          si++;
          if (globMatchSegs(patSegs, pathSegs, pi + 1, si, trail)) return true;
        }
        return false;
      }
      if (si >= pathSegs.length) {
        // A trailing slash supplies one empty segment: trailing globstars / zero-length
        // extglobs (`?(a)`, `*(a)`, `!(a)`) may match it.
        if (!trail) return false;
        for (var r = pi; r < patSegs.length; r++) {
          if (patSegs[r] !== '**' && !globNullable(patSegs[r])) return false;
        }
        return true;
      }
      if (!globSegToRegex(patSegs[pi]).test(pathSegs[si])) return false;
      pi++;
      si++;
    }
    return si === pathSegs.length;
  }

  function globParseRange(inner) {
    var num = /^(-?\d+)\.\.(-?\d+)$/.exec(inner);
    if (num) {
      var a = parseInt(num[1], 10);
      var b = parseInt(num[2], 10);
      var out = [];
      if (a <= b) for (var i = a; i <= b; i++) out.push(String(i));
      else for (var d = a; d >= b; d--) out.push(String(d));
      return out;
    }
    var ch = /^([A-Za-z])\.\.([A-Za-z])$/.exec(inner);
    if (ch) {
      var x = ch[1].charCodeAt(0);
      var y = ch[2].charCodeAt(0);
      var r = [];
      if (x <= y) for (var p = x; p <= y; p++) r.push(String.fromCharCode(p));
      else for (var q = x; q >= y; q--) r.push(String.fromCharCode(q));
      return r;
    }
    return null;
  }

  function globExpandBraces(pattern) {
    var open = -1;
    for (var i = 0; i < pattern.length; i++) {
      if (pattern[i] === '{') {
        open = i;
        break;
      }
    }
    if (open === -1) return [pattern];
    var depth = 0;
    var parts = [];
    var partStart = open + 1;
    var close = -1;
    for (var k = open; k < pattern.length; k++) {
      var c = pattern[k];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          parts.push(pattern.slice(partStart, k));
          close = k;
          break;
        }
      } else if (c === ',' && depth === 1) {
        parts.push(pattern.slice(partStart, k));
        partStart = k + 1;
      }
    }
    if (close === -1) return [pattern];
    var alts = parts;
    if (parts.length < 2) {
      var range = globParseRange(pattern.slice(open + 1, close));
      if (!range) return [pattern]; // a brace with no comma or range is literal
      alts = range;
    }
    var prefix = pattern.slice(0, open);
    var suffix = pattern.slice(close + 1);
    var out = [];
    for (var a = 0; a < alts.length; a++) {
      var expanded = globExpandBraces(alts[a] + suffix);
      for (var e = 0; e < expanded.length; e++) out.push(prefix + expanded[e]);
    }
    return out;
  }

  // Collapse `//`, resolve `.`/`..`, and report whether the path is absolute / directory.
  function globNormalize(s) {
    var absolute = s.length > 0 && s[0] === '/';
    var trailing = s.length > 1 && s[s.length - 1] === '/';
    var raw = s.split('/');
    var segs = [];
    for (var i = 0; i < raw.length; i++) {
      var seg = raw[i];
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (segs.length && segs[segs.length - 1] !== '..') segs.pop();
        else if (!absolute) segs.push('..');
        continue;
      }
      segs.push(seg);
    }
    return { segs: segs, absolute: absolute, trailing: trailing };
  }

  function globArgError(name, value) {
    var e = new TypeError(
      'The "' + name + '" argument must be of type string. Received ' + typeof value,
    );
    e.code = 'ERR_INVALID_ARG_TYPE';
    return e;
  }

  function makeMatchesGlob(winSep) {
    return function matchesGlob(path, pattern) {
      if (typeof path !== 'string') throw globArgError('path', path);
      if (typeof pattern !== 'string') throw globArgError('pattern', pattern);
      // windowsPathsNoEscape: '\' is a separator. No regex — these were global-flag
      // replaces, and a global replace under a forged `RegExp.prototype.exec` never
      // returns (it only advances `lastIndex` on an empty match), so `matchesGlob` span
      // the string until the engine gave up. node 24 hangs here too, so this is a
      // deviation in Lava's favour rather than a parity fix; pinned Lava-only by
      // cmd/lava/regexp_pollution_test.odin.
      pattern = replaceCharAll(pattern, '\\', '/');
      if (winSep) path = replaceCharAll(path, '\\', '/');
      var pathIsEmpty = path === '';
      var pathInfo = globNormalize(path);
      var patterns = globExpandBraces(pattern);
      for (var i = 0; i < patterns.length; i++) {
        var patInfo = globNormalize(patterns[i]);
        // Absolute/relative-ness must agree, except a pattern beginning with `**` (which
        // absorbs leading segments) may match an absolute path.
        if (
          patInfo.absolute !== pathInfo.absolute &&
          !(!patInfo.absolute && pathInfo.absolute && patInfo.segs[0] === '**')
        ) {
          continue;
        }
        if (patInfo.trailing && !pathInfo.trailing) continue;
        if (pathInfo.segs.length === 0) {
          // A path with no segments ('', '.', '..', './', …). Only the *literal* empty path
          // matches, and only a pattern whose segments are all globstars or zero-length
          // extglobs (`?(a)`, `*(a)`, `!(a)`) — which Node lets match nothing.
          if (
            pathIsEmpty &&
            patInfo.segs.length > 0 &&
            patInfo.segs.every(function (s) {
              return s === '**' || globNullable(s);
            })
          ) {
            return true;
          }
          continue;
        }
        if (globMatchSegs(patInfo.segs, pathInfo.segs, 0, 0, pathInfo.trailing)) return true;
      }
      return false;
    };
  }
  posix.matchesGlob = makeMatchesGlob(false);
  win32.matchesGlob = makeMatchesGlob(true);

  posix.posix = win32.posix = posix;
  posix.win32 = win32.win32 = win32;

  var isWindows = typeof process !== 'undefined' && process.platform === 'win32';
  module.exports = isWindows ? win32 : posix;
});
