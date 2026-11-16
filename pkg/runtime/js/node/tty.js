// node:tty — terminal helpers. isatty(fd) is backed by the native isatty syscall.
// WriteStream/ReadStream provide the TTY feature-detection surface (isTTY, columns/rows,
// getColorDepth/hasColors, getWindowSize, setRawMode); they are lightweight and do NOT
// implement full duplex stream I/O yet (this runtime has no node:stream base class), so
// they are primarily for capability checks (`stream.isTTY`, color/size detection).
(function (require, module, exports, native) {
  'use strict';

  var EventEmitter = require('events');
  var nativeIsatty = native && typeof native.isatty === 'function' ? native.isatty : null;

  function isatty(fd) {
    if (typeof fd !== 'number' || !Number.isInteger(fd) || fd < 0 || fd > 2147483647) {
      return false;
    }
    return nativeIsatty ? nativeIsatty(fd) : false;
  }

  function envInt(name, fallback) {
    var v = process.env[name];
    if (v === undefined) return fallback;
    var n = parseInt(v, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  }

  // Color depth as the base-2 log Node reports: 1 (no color), 4 (16), 8 (256), 24 (16m).
  // A simplified take on Node's algorithm via NO_COLOR / FORCE_COLOR / COLORTERM / TERM.
  function getColorDepth(env) {
    env = env || process.env;
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 1;
    if (env.FORCE_COLOR !== undefined) {
      switch (env.FORCE_COLOR) {
        case '':
        case '1':
        case 'true':
          return 4;
        case '2':
          return 8;
        case '3':
          return 24;
        case '0':
        case 'false':
          return 1;
        default:
          return 4;
      }
    }
    var term = env.TERM || '';
    if (term === 'dumb') return 1;
    if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 24;
    if (/-256(color)?$/i.test(term)) return 8;
    if (
      /^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(term) ||
      env.COLORTERM !== undefined
    ) {
      return 4;
    }
    return 1;
  }

  function hasColors(count, env) {
    if (typeof count === 'object' && count !== null) {
      env = count;
      count = 16;
    }
    if (count === undefined) count = 16;
    // getColorDepth returns the bit depth; the palette size is 2**depth.
    return count <= 2 ** getColorDepth(env);
  }

  function getWindowSize() {
    return [envInt('COLUMNS', 80), envInt('LINES', 24)];
  }

  // Note: Node throws ERR_TTY_INIT_FAILED when constructing a TTY stream on certain
  // non-tty fds, but the exact set is libuv/fd-type specific (it throws for a regular
  // file yet not always for a pipe). These constructors are forgiving instead: they
  // never throw and set isTTY from isatty(fd), which is the more useful behavior for
  // capability checks and avoids breaking code that constructs on a redirected fd.
  function ReadStream(fd) {
    if (!(this instanceof ReadStream)) return new ReadStream(fd);
    EventEmitter.call(this);
    this.fd = fd;
    this.isTTY = isatty(fd);
    this.isRaw = false;
  }
  ReadStream.prototype = Object.create(EventEmitter.prototype);
  ReadStream.prototype.constructor = ReadStream;
  ReadStream.prototype.setRawMode = function (mode) {
    this.isRaw = !!mode;
    return this; // raw-mode termios toggling is not implemented yet (Linux-first TODO)
  };

  function WriteStream(fd) {
    if (!(this instanceof WriteStream)) return new WriteStream(fd);
    EventEmitter.call(this);
    this.fd = fd;
    this.isTTY = isatty(fd);
    var size = getWindowSize();
    this.columns = size[0];
    this.rows = size[1];
  }
  WriteStream.prototype = Object.create(EventEmitter.prototype);
  WriteStream.prototype.constructor = WriteStream;
  WriteStream.prototype.getColorDepth = function (env) {
    return getColorDepth(env);
  };
  WriteStream.prototype.hasColors = function (count, env) {
    return hasColors(count, env);
  };
  WriteStream.prototype.getWindowSize = function () {
    return [this.columns, this.rows];
  };

  module.exports = {
    isatty: isatty,
    ReadStream: ReadStream,
    WriteStream: WriteStream,
  };
});
