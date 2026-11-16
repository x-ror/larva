// node:os — operating-system info, modeled on Node's `os`. The split mirrors
// Node/libuv: anything that is a pure function of process.platform/process.env or
// a fixed per-platform constant is computed here in JS (homedir, tmpdir, EOL,
// devNull, endianness, constants), while the live system numbers that require a
// syscall (hostname, uname, total/free memory, uptime, load average, cpus,
// network interfaces, user info, priority) come from the Odin bridge
// (pkg/runtime/os.odin + the per-platform os_*.odin files) via `native`.
//
// Non-deterministic values (memory, uptime, cpus, …) are returned as-is; the
// node-compat oracle asserts their SHAPE rather than their magnitude, since they
// differ run-to-run and host-to-host.
(function (require, module, exports, native) {
  'use strict';

  // Pristine, from the loader. This was read LIVE inside userInfo() — re-resolved on
  // every call, so `require('buffer').Buffer = shim` steered it at any time, not merely
  // before the first require of this module (#333).
  // Through primordials, not captured here: this module is lazy (#333).
  var OsPrimordials = require('internal/primordials');
  var StringG = OsPrimordials.String;
  var StringPrototypeToLowerCase = OsPrimordials.StringPrototypeToLowerCase;
  var PristineBuffer = require.pristineBuffer;
  var BufferFrom = PristineBuffer.from;
  var BufferPrototypeToString = PristineBuffer.bufferToString;
  var BufferIsEncoding = PristineBuffer.isEncoding;

  if (!native) {
    throw new OsPrimordials.Error('node:os is unavailable: native bindings missing');
  }

  var isWindows = process.platform === 'win32';

  // ---- endianness: probe the host byte order once (cheap, deterministic) -----
  // Intrinsics, not the live globals — this module is LAZY (#426). The getter rather than
  // `.buffer` for the same reason: it is a configurable prototype accessor.
  var _endianness =
    new OsPrimordials.Uint8Array(
      OsPrimordials.TypedArrayPrototypeGetBuffer(new OsPrimordials.Uint16Array([1])),
    )[0] === 1
      ? 'LE'
      : 'BE';

  // ---- pure constants --------------------------------------------------------
  var EOL = isWindows ? '\r\n' : '\n';
  var devNull = isWindows ? '\\\\.\\nul' : '/dev/null';

  // os.type() is the uname sysname; for the platforms Node supports it is a fixed
  // string, so map it from process.platform and only fall back to the native
  // uname for anything exotic. Keeps the hot path syscall-free.
  function type() {
    switch (process.platform) {
      case 'linux':
        return 'Linux';
      case 'darwin':
        return 'Darwin';
      case 'win32':
        return 'Windows_NT';
      default:
        return native.type();
    }
  }

  // ---- homedir / tmpdir: libuv's algorithm (env first, then the password DB) --
  // uv_os_homedir reads the env var with getenv and only falls back to the passwd
  // DB when it is *unset* (UV_ENOENT). An explicitly empty HOME/USERPROFILE is a
  // value, so it is returned verbatim — hence a presence test, not a truthiness one.
  function homedir() {
    var key = isWindows ? 'USERPROFILE' : 'HOME';
    return Object.hasOwn(process.env, key) ? process.env[key] : native.homedir();
  }

  // uv_os_tmpdir: first env var that is set wins; a trailing separator is trimmed
  // unless the whole path is the root. POSIX consults TMPDIR/TMP/TEMP then /tmp;
  // Windows consults TEMP/TMP then the system root.
  function tmpdir() {
    if (isWindows) {
      var winPath =
        process.env.TEMP ||
        process.env.TMP ||
        (process.env.SystemRoot || process.env.windir || '') + '\\temp';
      // Trim a single trailing backslash, but keep a drive root like "C:\".
      var isDriveRoot = winPath.length === 3 && winPath[1] === ':';
      if (winPath.length > 1 && winPath.endsWith('\\') && !isDriveRoot) {
        winPath = winPath.slice(0, -1);
      }
      return winPath;
    }
    var path = process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    return path;
  }

  // ---- os.constants ----------------------------------------------------------
  // signals + errno are platform-specific numbers straight from the system
  // headers; priority/dlopen/UV are libuv's cross-platform abstraction. Values
  // mirror Node's so feature-detection and `process.kill(pid, 'SIGTERM')`-style
  // lookups resolve to the same numbers the host kernel uses.
  var signals;
  if (process.platform === 'darwin') {
    signals = {
      SIGHUP: 1,
      SIGINT: 2,
      SIGQUIT: 3,
      SIGILL: 4,
      SIGTRAP: 5,
      SIGABRT: 6,
      SIGIOT: 6,
      SIGEMT: 7,
      SIGFPE: 8,
      SIGKILL: 9,
      SIGBUS: 10,
      SIGSEGV: 11,
      SIGSYS: 12,
      SIGPIPE: 13,
      SIGALRM: 14,
      SIGTERM: 15,
      SIGURG: 16,
      SIGSTOP: 17,
      SIGTSTP: 18,
      SIGCONT: 19,
      SIGCHLD: 20,
      SIGTTIN: 21,
      SIGTTOU: 22,
      SIGIO: 23,
      SIGXCPU: 24,
      SIGXFSZ: 25,
      SIGVTALRM: 26,
      SIGPROF: 27,
      SIGWINCH: 28,
      SIGINFO: 29,
      SIGUSR1: 30,
      SIGUSR2: 31,
    };
  } else if (isWindows) {
    signals = {
      SIGHUP: 1,
      SIGINT: 2,
      SIGILL: 4,
      SIGABRT: 22,
      SIGFPE: 8,
      SIGKILL: 9,
      SIGSEGV: 11,
      SIGTERM: 15,
      SIGBREAK: 21,
      SIGWINCH: 28,
    };
  } else {
    signals = {
      SIGHUP: 1,
      SIGINT: 2,
      SIGQUIT: 3,
      SIGILL: 4,
      SIGTRAP: 5,
      SIGABRT: 6,
      SIGIOT: 6,
      SIGBUS: 7,
      SIGFPE: 8,
      SIGKILL: 9,
      SIGUSR1: 10,
      SIGSEGV: 11,
      SIGUSR2: 12,
      SIGPIPE: 13,
      SIGALRM: 14,
      SIGTERM: 15,
      SIGSTKFLT: 16,
      SIGCHLD: 17,
      SIGCONT: 18,
      SIGSTOP: 19,
      SIGTSTP: 20,
      SIGTTIN: 21,
      SIGTTOU: 22,
      SIGURG: 23,
      SIGXCPU: 24,
      SIGXFSZ: 25,
      SIGVTALRM: 26,
      SIGPROF: 27,
      SIGWINCH: 28,
      SIGIO: 29,
      SIGPOLL: 29,
      SIGPWR: 30,
      SIGSYS: 31,
    };
  }

  // errno numbers straight from the host's <errno.h>; the values differ between
  // Linux and the BSD/Darwin libc (e.g. EAGAIN is 11 vs 35), so they are branded
  // per platform exactly as Node derives them from the system headers. Packages
  // that compare `os.constants.errno.EXXX` against a raw errno resolve identically.
  var errno;
  if (process.platform === 'darwin') {
    errno = {
      E2BIG: 7,
      EACCES: 13,
      EADDRINUSE: 48,
      EADDRNOTAVAIL: 49,
      EAFNOSUPPORT: 47,
      EAGAIN: 35,
      EALREADY: 37,
      EBADF: 9,
      EBADMSG: 94,
      EBUSY: 16,
      ECANCELED: 89,
      ECHILD: 10,
      ECONNABORTED: 53,
      ECONNREFUSED: 61,
      ECONNRESET: 54,
      EDEADLK: 11,
      EDESTADDRREQ: 39,
      EDOM: 33,
      EDQUOT: 69,
      EEXIST: 17,
      EFAULT: 14,
      EFBIG: 27,
      EHOSTUNREACH: 65,
      EIDRM: 90,
      EILSEQ: 92,
      EINPROGRESS: 36,
      EINTR: 4,
      EINVAL: 22,
      EIO: 5,
      EISCONN: 56,
      EISDIR: 21,
      ELOOP: 62,
      EMFILE: 24,
      EMLINK: 31,
      EMSGSIZE: 40,
      EMULTIHOP: 95,
      ENAMETOOLONG: 63,
      ENETDOWN: 50,
      ENETRESET: 52,
      ENETUNREACH: 51,
      ENFILE: 23,
      ENOBUFS: 55,
      ENODATA: 96,
      ENODEV: 19,
      ENOENT: 2,
      ENOEXEC: 8,
      ENOLCK: 77,
      ENOLINK: 97,
      ENOMEM: 12,
      ENOMSG: 91,
      ENOPROTOOPT: 42,
      ENOSPC: 28,
      ENOSR: 98,
      ENOSTR: 99,
      ENOSYS: 78,
      ENOTCONN: 57,
      ENOTDIR: 20,
      ENOTEMPTY: 66,
      ENOTSOCK: 38,
      ENOTSUP: 45,
      ENOTTY: 25,
      ENXIO: 6,
      EOPNOTSUPP: 102,
      EOVERFLOW: 84,
      EPERM: 1,
      EPIPE: 32,
      EPROTO: 100,
      EPROTONOSUPPORT: 43,
      EPROTOTYPE: 41,
      ERANGE: 34,
      EROFS: 30,
      ESPIPE: 29,
      ESRCH: 3,
      ESTALE: 70,
      ETIME: 101,
      ETIMEDOUT: 60,
      ETXTBSY: 26,
      EWOULDBLOCK: 35,
      EXDEV: 18,
    };
  } else if (isWindows) {
    // MSVC <errno.h>: the C base (1..42) plus the POSIX-2008 additions (100..140).
    errno = {
      E2BIG: 7,
      EACCES: 13,
      EADDRINUSE: 100,
      EADDRNOTAVAIL: 101,
      EAFNOSUPPORT: 102,
      EAGAIN: 11,
      EALREADY: 103,
      EBADF: 9,
      EBADMSG: 104,
      EBUSY: 16,
      ECANCELED: 105,
      ECHILD: 10,
      ECONNABORTED: 106,
      ECONNREFUSED: 107,
      ECONNRESET: 108,
      EDEADLK: 36,
      EDESTADDRREQ: 109,
      EDOM: 33,
      EEXIST: 17,
      EFAULT: 14,
      EFBIG: 27,
      EHOSTUNREACH: 110,
      EIDRM: 111,
      EILSEQ: 42,
      EINPROGRESS: 112,
      EINTR: 4,
      EINVAL: 22,
      EIO: 5,
      EISCONN: 113,
      EISDIR: 21,
      ELOOP: 114,
      EMFILE: 24,
      EMLINK: 31,
      EMSGSIZE: 115,
      ENAMETOOLONG: 38,
      ENETDOWN: 116,
      ENETRESET: 117,
      ENETUNREACH: 118,
      ENFILE: 23,
      ENOBUFS: 119,
      ENODATA: 120,
      ENODEV: 19,
      ENOENT: 2,
      ENOEXEC: 8,
      ENOLCK: 39,
      ENOLINK: 121,
      ENOMEM: 12,
      ENOMSG: 122,
      ENOPROTOOPT: 123,
      ENOSPC: 28,
      ENOSR: 124,
      ENOSTR: 125,
      ENOSYS: 40,
      ENOTCONN: 126,
      ENOTDIR: 20,
      ENOTEMPTY: 41,
      ENOTRECOVERABLE: 127,
      ENOTSOCK: 128,
      ENOTSUP: 129,
      ENOTTY: 25,
      ENXIO: 6,
      EOPNOTSUPP: 130,
      EOVERFLOW: 132,
      EOWNERDEAD: 133,
      EPERM: 1,
      EPIPE: 32,
      EPROTO: 134,
      EPROTONOSUPPORT: 135,
      EPROTOTYPE: 136,
      ERANGE: 34,
      EROFS: 30,
      ESPIPE: 29,
      ESRCH: 3,
      ETIME: 137,
      ETIMEDOUT: 138,
      ETXTBSY: 139,
      EWOULDBLOCK: 140,
      EXDEV: 18,
    };
  } else {
    // Linux asm-generic errno values (identical on x86_64/arm/arm64/riscv).
    errno = {
      E2BIG: 7,
      EACCES: 13,
      EADDRINUSE: 98,
      EADDRNOTAVAIL: 99,
      EAFNOSUPPORT: 97,
      EAGAIN: 11,
      EALREADY: 114,
      EBADF: 9,
      EBADMSG: 74,
      EBUSY: 16,
      ECANCELED: 125,
      ECHILD: 10,
      ECONNABORTED: 103,
      ECONNREFUSED: 111,
      ECONNRESET: 104,
      EDEADLK: 35,
      EDESTADDRREQ: 89,
      EDOM: 33,
      EDQUOT: 122,
      EEXIST: 17,
      EFAULT: 14,
      EFBIG: 27,
      EHOSTUNREACH: 113,
      EIDRM: 43,
      EILSEQ: 84,
      EINPROGRESS: 115,
      EINTR: 4,
      EINVAL: 22,
      EIO: 5,
      EISCONN: 106,
      EISDIR: 21,
      ELOOP: 40,
      EMFILE: 24,
      EMLINK: 31,
      EMSGSIZE: 90,
      EMULTIHOP: 72,
      ENAMETOOLONG: 36,
      ENETDOWN: 100,
      ENETRESET: 102,
      ENETUNREACH: 101,
      ENFILE: 23,
      ENOBUFS: 105,
      ENODATA: 61,
      ENODEV: 19,
      ENOENT: 2,
      ENOEXEC: 8,
      ENOLCK: 37,
      ENOLINK: 67,
      ENOMEM: 12,
      ENOMSG: 42,
      ENOPROTOOPT: 92,
      ENOSPC: 28,
      ENOSR: 63,
      ENOSTR: 60,
      ENOSYS: 38,
      ENOTCONN: 107,
      ENOTDIR: 20,
      ENOTEMPTY: 39,
      ENOTSOCK: 88,
      ENOTSUP: 95,
      ENOTTY: 25,
      ENXIO: 6,
      EOPNOTSUPP: 95,
      EOVERFLOW: 75,
      EPERM: 1,
      EPIPE: 32,
      EPROTO: 71,
      EPROTONOSUPPORT: 93,
      EPROTOTYPE: 91,
      ERANGE: 34,
      EROFS: 30,
      ESPIPE: 29,
      ESRCH: 3,
      ESTALE: 116,
      ETIME: 62,
      ETIMEDOUT: 110,
      ETXTBSY: 26,
      EWOULDBLOCK: 11,
      EXDEV: 18,
    };
  }

  // libuv priority band (UV_PRIORITY_*): identical on every platform. setPriority
  // validates user input is an integer in [HIGHEST, LOW] = [-20, 19] (no clamp).
  var priority = {
    PRIORITY_LOW: 19,
    PRIORITY_BELOW_NORMAL: 10,
    PRIORITY_NORMAL: 0,
    PRIORITY_ABOVE_NORMAL: -7,
    PRIORITY_HIGH: -14,
    PRIORITY_HIGHEST: -20,
  };

  // dlopen flags (RTLD_*). Linux and Darwin disagree on the bit values, so brand
  // them per host; absent on Windows (no dlopen).
  var dlopen;
  if (process.platform === 'darwin') {
    dlopen = { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_LOCAL: 4, RTLD_GLOBAL: 8 };
  } else if (!isWindows) {
    dlopen = { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0 };
  } else {
    dlopen = {};
  }

  var constants = {
    UV_UDP_REUSEADDR: 4,
    errno: errno,
    signals: signals,
    priority: priority,
    dlopen: dlopen,
  };

  // ---- cpus(): the native bridge returns plain records; pass them through ----
  // Each entry is { model, speed, times: { user, nice, sys, idle, irq } }, the
  // exact Node shape, so no reshaping is needed here.
  function cpus() {
    return native.cpus();
  }

  // ---- loadavg(): always a 3-element array of numbers (0,0,0 on Windows) -----
  function loadavg() {
    return native.loadavg();
  }

  // ---- networkInterfaces(): group the flat native records by interface name --
  // Native returns a flat list of { name, address, netmask, family (4|6), mac,
  // internal, scopeid }. Node groups them by name and decorates each with the
  // string family ('IPv4'/'IPv6') and a CIDR. scopeid is only meaningful for
  // IPv6 (null otherwise, as in Node).
  function networkInterfaces() {
    var list = native.networkInterfaces();
    var out = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      var entry = {
        address: rec.address,
        netmask: rec.netmask,
        family: rec.family === 6 ? 'IPv6' : 'IPv4',
        mac: rec.mac,
        internal: rec.internal,
      };
      if (rec.family === 6) {
        entry.scopeid = rec.scopeid;
      }
      entry.cidr = toCidr(rec.address, rec.netmask, rec.family);
      if (!out[rec.name]) out[rec.name] = [];
      out[rec.name].push(entry);
    }
    return out;
  }

  // toCidr renders "address/prefixlen" by counting the set bits of the netmask,
  // matching Node's uv_interface_addresses → cidr. Returns null when the netmask
  // is unusable (Node does the same).
  function toCidr(address, netmask, family) {
    var bits = family === 6 ? cidrBitsV6(netmask) : cidrBitsV4(netmask);
    return bits === null ? null : address + '/' + bits;
  }

  function popcount8(n) {
    var c = 0;
    while (n) {
      c += n & 1;
      n >>= 1;
    }
    return c;
  }

  function cidrBitsV4(netmask) {
    var parts = netmask.split('.');
    if (parts.length !== 4) return null;
    var bits = 0;
    for (var i = 0; i < 4; i++) {
      var n = Number(parts[i]);
      if (n < 0 || n > 255 || Number.isNaN(n)) return null;
      bits += popcount8(n);
    }
    return bits;
  }

  function cidrBitsV6(netmask) {
    // Expand "::" and count set bits across the eight 16-bit groups.
    var groups = expandV6(netmask);
    if (groups === null) return null;
    var bits = 0;
    for (var i = 0; i < groups.length; i++) {
      bits += popcount8((groups[i] >> 8) & 0xff) + popcount8(groups[i] & 0xff);
    }
    return bits;
  }

  function expandV6(addr) {
    var halves = addr.split('::');
    if (halves.length > 2) return null;
    var head = halves[0] ? halves[0].split(':') : [];
    var tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    var fill = 8 - head.length - tail.length;
    if (halves.length === 1) {
      if (head.length !== 8) return null;
      fill = 0;
    } else if (fill < 0) {
      return null;
    }
    var groups = [];
    for (var i = 0; i < head.length; i++) groups.push(parseInt(head[i], 16) || 0);
    for (var f = 0; f < fill; f++) groups.push(0);
    for (var j = 0; j < tail.length; j++) groups.push(parseInt(tail[j], 16) || 0);
    return groups.length === 8 ? groups : null;
  }

  // ---- userInfo(): { uid, gid, username, homedir, shell }. Only the exact option
  // { encoding: 'buffer' } returns username/homedir/shell as Buffers; every other
  // encoding (utf8, latin1, an unknown name, a non-object options arg) yields the
  // decoded strings — Node treats 'buffer' as the sole Buffer trigger. uid/gid are
  // -1 on Windows.
  /**
   * @param {{encoding?: string}} [options]
   * @returns {{uid:number, gid:number, username:*, homedir:*, shell:*}} A NULL-PROTOTYPE
   *          object, as node returns.
   * @node Verified on node 26.13.0, and three things here are easy to get wrong:
   *       - the result has a null prototype (`typeof info.hasOwnProperty === 'undefined'`);
   *       - the encoding goes through node's ParseEncoding, so it is CASE-INSENSITIVE:
   *         'buffer', 'BUFFER' and 'bUfFeR' all yield Buffers;
   *       - any other known encoding TRANSCODES the strings rather than being ignored —
   *         'hex' gives "74796d6368", 'base64' "dHltY2g=", 'ucs2' the utf16 reading.
   *       An earlier comment here claimed 'buffer' was the sole trigger; it is not.
   * @deviates none
   */
  function userInfo(options) {
    var info = native.userInfo();
    var encoding = options && options.encoding;
    // Null-prototype, matching node: this object is handed to user code and a `toString`
    // or `hasOwnProperty` inherited from Object.prototype is an observable difference.
    var out = { __proto__: null, uid: info.uid, gid: info.gid };
    if (encoding === undefined || encoding === null) {
      out.username = info.username;
      out.homedir = info.homedir;
      out.shell = info.shell;
      return out;
    }
    var enc = typeof encoding === 'string' ? StringPrototypeToLowerCase(encoding) : '';
    if (enc === 'buffer') {
      out.username = BufferFrom(info.username, 'utf8');
      out.homedir = BufferFrom(info.homedir, 'utf8');
      out.shell = info.shell === null ? null : BufferFrom(info.shell, 'utf8');
      return out;
    }
    // An UNRECOGNIZED encoding is not an error on node — ParseEncoding answers UNKNOWN and
    // the plain string is returned. Measured: 'not-an-encoding', '', false, 0, 123 and {}
    // all give "tymch", none throws. An earlier revision here routed the unknown name into
    // Buffer#toString, which threw ERR_UNKNOWN_ENCODING and broke case 35-os.
    if (!BufferIsEncoding(enc)) {
      out.username = info.username;
      out.homedir = info.homedir;
      out.shell = info.shell;
      return out;
    }
    out.username = BufferPrototypeToString(BufferFrom(info.username, 'utf8'), enc);
    out.homedir = BufferPrototypeToString(BufferFrom(info.homedir, 'utf8'), enc);
    out.shell =
      info.shell === null ? null : BufferPrototypeToString(BufferFrom(info.shell, 'utf8'), enc);
    return out;
  }

  // ---- arg validation: Node's validateInt32, reproducing the ERR_* code/message
  // shapes so callers see the same TypeError/RangeError they do under Node.
  var errors = require('internal/errors');
  var invalidArgType = errors.ERR_INVALID_ARG_TYPE;
  var outOfRange = errors.ERR_OUT_OF_RANGE;
  function validateInt32(value, name, min, max) {
    if (min === undefined) min = -0x80000000;
    if (max === undefined) max = 0x7fffffff;
    if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
    if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
    if (value < min || value > max) throw outOfRange(name, '>= ' + min + ' && <= ' + max, value);
    return value;
  }

  // ---- get/setPriority: pid/priority are validated as int32 here (priority into
  // the libuv band [-20, 19], no clamp); the native side performs the syscall and
  // throws an ERR_SYSTEM_ERROR for an unknown pid / EPERM. A 0/omitted pid means
  // the current process (Node parity).
  function getPriority(pid) {
    if (pid === undefined) pid = 0;
    validateInt32(pid, 'pid');
    return native.getPriority(pid);
  }

  function setPriority(pid, priorityValue) {
    // Node allows setPriority(priority) — a single arg is the priority, pid = 0.
    if (priorityValue === undefined) {
      priorityValue = pid;
      pid = 0;
    }
    validateInt32(pid, 'pid');
    validateInt32(priorityValue, 'priority', -20, 19);
    native.setPriority(pid, priorityValue);
  }

  module.exports = {
    arch: function () {
      return process.arch;
    },
    platform: function () {
      return process.platform;
    },
    type: type,
    release: function () {
      return native.release();
    },
    version: function () {
      return native.version();
    },
    machine: function () {
      return native.machine();
    },
    hostname: function () {
      return native.hostname();
    },
    endianness: function () {
      return _endianness;
    },
    homedir: homedir,
    tmpdir: tmpdir,
    totalmem: function () {
      return native.totalmem();
    },
    freemem: function () {
      return native.freemem();
    },
    uptime: function () {
      return native.uptime();
    },
    loadavg: loadavg,
    cpus: cpus,
    availableParallelism: function () {
      return native.availableParallelism();
    },
    getPriority: getPriority,
    setPriority: setPriority,
    networkInterfaces: networkInterfaces,
    userInfo: userInfo,
    constants: constants,
    EOL: EOL,
    devNull: devNull,
  };
});
