(function (out, err) {
  'use strict';

  var groupIndent = '';
  var counts = Object.create(null);
  var timers = Object.create(null);

  var customInspect =
    typeof Symbol !== 'undefined' && Symbol.for ? Symbol.for('nodejs.util.inspect.custom') : null;

  function quote(s) {
    return "'" + s.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n') + "'";
  }

  function inspect(v, seen, depth) {
    var t = typeof v;
    if (v === null) return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'string') return quote(v);
    if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
    if (t === 'boolean') return String(v);
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol') return v.toString();
    if (t === 'function') {
      var fn = v.name;
      return fn ? '[Function: ' + fn + ']' : '[Function (anonymous)]';
    }
    // Honor the util.inspect custom hook (Buffer renders as "<Buffer ..>"). Node
    // passes (depth, options, inspect) and inspects a non-string result in place
    // (a string is used verbatim; returning the object itself falls through).
    if (customInspect && typeof v[customInspect] === 'function') {
      var nested = seen.concat([v]);
      var recurse = function (val) {
        return inspect(val, nested, depth + 1);
      };
      var custom = v[customInspect](depth, {}, recurse);
      if (custom !== v) {
        return typeof custom === 'string' ? custom : inspect(custom, nested, depth);
      }
    }
    if (seen.indexOf(v) !== -1) return '[Circular *1]';
    if (v instanceof Error) return v.stack ? v.stack : v.name + ': ' + v.message;
    if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return v.toString();
    if (depth > 4) return Array.isArray(v) ? '[Array]' : '[Object]';
    seen = seen.concat([v]);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      var arr = [];
      for (var i = 0; i < v.length; i++) arr.push(inspect(v[i], seen, depth + 1));
      return '[ ' + arr.join(', ') + ' ]';
    }
    if (typeof Map !== 'undefined' && v instanceof Map) {
      var mp = [];
      v.forEach(function (val, key) {
        mp.push(inspect(key, seen, depth + 1) + ' => ' + inspect(val, seen, depth + 1));
      });
      return 'Map(' + v.size + ') {' + (mp.length > 0 ? ' ' + mp.join(', ') + ' ' : '') + '}';
    }
    if (typeof Set !== 'undefined' && v instanceof Set) {
      var st = [];
      v.forEach(function (val) {
        st.push(inspect(val, seen, depth + 1));
      });
      return 'Set(' + v.size + ') {' + (st.length > 0 ? ' ' + st.join(', ') + ' ' : '') + '}';
    }
    var keys = Object.keys(v);
    var ctor = v.constructor && v.constructor.name;
    var prefix = ctor && ctor !== 'Object' ? ctor + ' ' : '';
    if (keys.length === 0) return prefix + '{}';
    var props = [];
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var label = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quote(key);
      props.push(label + ': ' + inspect(v[key], seen, depth + 1));
    }
    return prefix + '{ ' + props.join(', ') + ' }';
  }

  function stringify(v) {
    return typeof v === 'string' ? v : inspect(v, [], 0);
  }

  function formatArgs(args) {
    if (args.length === 0) return '';
    var first = args[0];
    // Node's short circuit, and it must come BEFORE the substitution loop rather
    // than inside it: a lone string argument is the answer, directives and all.
    // `format('%s')`, `format('%z')`, `format('100%')` and `format('%%')` all come
    // back untouched on node 24 (verified, not read off the docs).
    // Only `%%` used to get this wrong here — `%s` and friends were saved further
    // down by the "arguments exhausted" branch, which re-emits the directive, while
    // `%%` was folded unconditionally.
    // `typeof first === 'string'` matters: `format(5, '%%')` has no format string
    // at all, so node inspects and space-joins, leaving the later `%%` literal.
    // Duplicated from internal/util.js rather than shared, and deliberately: this
    // prelude runs before the module loader, receives only the native write
    // functions, and has no `require` to reach util with.
    if (args.length === 1 && typeof first === 'string') return first;
    var i = 1;
    var result;
    if (typeof first === 'string' && first.indexOf('%') !== -1) {
      result = '';
      for (var p = 0; p < first.length; p++) {
        var ch = first.charAt(p);
        if (ch === '%' && p + 1 < first.length) {
          var spec = first.charAt(p + 1);
          if (spec === '%') {
            result += '%';
            p++;
            continue;
          }
          if ('sdifjoOc'.indexOf(spec) !== -1) {
            if (i >= args.length && spec !== '%') {
              result += '%' + spec;
              p++;
              continue;
            }
            var a = args[i++];
            p++;
            if (spec === 's') result += typeof a === 'string' ? a : stringify(a);
            else if (spec === 'd' || spec === 'i')
              result +=
                typeof a === 'bigint'
                  ? String(a) + 'n'
                  : typeof a === 'symbol'
                    ? 'NaN'
                    : String(Math.trunc(Number(a)));
            else if (spec === 'f') result += typeof a === 'symbol' ? 'NaN' : String(parseFloat(a));
            else if (spec === 'j') {
              try {
                result += JSON.stringify(a);
              } catch {
                result += '[Circular]';
              }
            } else if (spec === 'o' || spec === 'O') result += inspect(a, [], 0);
            /* spec === "c": CSS directive, consumed and ignored */
            continue;
          }
        }
        result += ch;
      }
    } else {
      result = stringify(first);
    }
    for (; i < args.length; i++) result += ' ' + stringify(args[i]);
    return result;
  }

  function emit(writer, text) {
    if (groupIndent) text = groupIndent + text.split('\n').join('\n' + groupIndent);
    writer(text + '\n');
  }

  function line(writer, args) {
    emit(writer, formatArgs(args));
  }

  // Duration formatting ported from Node's lib/internal/console/constructor.js
  // (formatTime): sub-second as "0.123ms", seconds as "1.500s", and minutes /
  // hours as "m:ss.mmm" / "h:mm:ss.mmm". Our timer values are integer
  // milliseconds (Date.now) rather than process.hrtime, so the fractional part
  // is currently always .000 — the format still matches Node once a hi-res
  // clock lands (roadmap: "real wall-clock timers").
  var kSecond = 1000,
    kMinute = 60 * kSecond,
    kHour = 60 * kMinute;
  function pad(value) {
    return String(value).padStart(2, '0');
  }
  function duration(ms) {
    var hours = 0,
      minutes = 0,
      seconds = 0;
    if (ms >= kSecond) {
      if (ms >= kMinute) {
        if (ms >= kHour) {
          hours = Math.floor(ms / kHour);
          ms = ms % kHour;
        }
        minutes = Math.floor(ms / kMinute);
        ms = ms % kMinute;
      }
      seconds = ms / kSecond;
    }
    if (hours !== 0 || minutes !== 0) {
      var parts = seconds.toFixed(3).split('.');
      var res = hours !== 0 ? hours + ':' + pad(minutes) : String(minutes);
      return (
        res + ':' + pad(parts[0]) + '.' + parts[1] + ' (' + (hours !== 0 ? 'h:m' : '') + 'm:ss.mmm)'
      );
    }
    if (seconds !== 0) return seconds.toFixed(3) + 's';
    return Number(ms.toFixed(3)) + 'ms';
  }

  function table(data, columnsFilter) {
    if (data === null || typeof data !== 'object') {
      line(out, [data]);
      return;
    }
    var indexKeys = Object.keys(data);
    var columnSet = [];
    var hasValues = false;
    var rows = [];
    for (var r = 0; r < indexKeys.length; r++) {
      var key = indexKeys[r];
      var item = data[key];
      var row = { index: key, cells: Object.create(null), value: undefined };
      if (
        item !== null &&
        typeof item === 'object' &&
        !(item instanceof Date) &&
        !(item instanceof RegExp)
      ) {
        var ik = Object.keys(item);
        for (var c = 0; c < ik.length; c++) {
          var col = ik[c];
          if (columnsFilter && columnsFilter.indexOf(col) === -1) continue;
          if (columnSet.indexOf(col) === -1) columnSet.push(col);
          row.cells[col] = inspect(item[col], [], 0);
        }
      } else {
        hasValues = true;
        row.value = inspect(item, [], 0);
      }
      rows.push(row);
    }
    var headers = ['(index)'].concat(columnSet);
    if (hasValues) headers.push('Values');
    var matrix = [headers];
    for (var r2 = 0; r2 < rows.length; r2++) {
      var rr = rows[r2];
      var record = [rr.index];
      for (var c2 = 0; c2 < columnSet.length; c2++) {
        var cv = rr.cells[columnSet[c2]];
        record.push(cv === undefined ? '' : cv);
      }
      if (hasValues) record.push(rr.value === undefined ? '' : rr.value);
      matrix.push(record);
    }
    var widths = [];
    for (var w = 0; w < headers.length; w++) {
      var max = 0;
      for (var m = 0; m < matrix.length; m++) {
        var cell = String(matrix[m][w] === undefined ? '' : matrix[m][w]);
        if (cell.length > max) max = cell.length;
      }
      widths.push(max);
    }
    function pad(value, width) {
      value = String(value);
      return ' ' + value + ' '.repeat(width - value.length) + ' ';
    }
    function rule(l, mid, rgt) {
      var segs = [];
      for (var s = 0; s < widths.length; s++) segs.push('─'.repeat(widths[s] + 2));
      return l + segs.join(mid) + rgt;
    }
    function rowText(cells) {
      var parts = [];
      for (var c3 = 0; c3 < widths.length; c3++)
        parts.push(pad(cells[c3] === undefined ? '' : cells[c3], widths[c3]));
      return '│' + parts.join('│') + '│';
    }
    var lines = [rule('┌', '┬', '┐'), rowText(headers), rule('├', '┼', '┤')];
    for (var r3 = 1; r3 < matrix.length; r3++) lines.push(rowText(matrix[r3]));
    lines.push(rule('└', '┴', '┘'));
    emit(out, lines.join('\n'));
  }

  function args(a) {
    return Array.prototype.slice.call(a);
  }
  function label(x) {
    return x === undefined ? 'default' : String(x);
  }

  var console = {
    log: function () {
      line(out, args(arguments));
    },
    info: function () {
      line(out, args(arguments));
    },
    debug: function () {
      line(out, args(arguments));
    },
    dirxml: function () {
      line(out, args(arguments));
    },
    error: function () {
      line(err, args(arguments));
    },
    warn: function () {
      line(err, args(arguments));
    },
    dir: function (obj) {
      emit(out, inspect(obj, [], 0));
    },
    trace: function () {
      var msg = formatArgs(args(arguments));
      var e = new Error();
      var stack = e.stack ? e.stack.split('\n').slice(1).join('\n') : '';
      emit(err, 'Trace' + (msg ? ': ' + msg : '') + (stack ? '\n' + stack : ''));
    },
    assert: function (value) {
      if (value) return;
      var msg = formatArgs(Array.prototype.slice.call(arguments, 1));
      emit(err, 'Assertion failed' + (msg ? ': ' + msg : ''));
    },
    count: function (name) {
      var key = label(name);
      counts[key] = (counts[key] || 0) + 1;
      emit(out, key + ': ' + counts[key]);
    },
    countReset: function (name) {
      var key = label(name);
      if (counts[key] === undefined) {
        emit(err, "Warning: Count for '" + key + "' does not exist");
        return;
      }
      delete counts[key];
    },
    group: function () {
      if (arguments.length > 0) line(out, args(arguments));
      groupIndent += '  ';
    },
    groupCollapsed: function () {
      if (arguments.length > 0) line(out, args(arguments));
      groupIndent += '  ';
    },
    groupEnd: function () {
      groupIndent = groupIndent.slice(0, -2);
    },
    time: function (name) {
      var key = label(name);
      if (timers[key] !== undefined) {
        emit(err, "Warning: Label '" + key + "' already exists for console.time()");
        return;
      }
      timers[key] = Date.now();
    },
    timeEnd: function (name) {
      var key = label(name);
      if (timers[key] === undefined) {
        emit(err, "Warning: No such label '" + key + "' for console.timeEnd()");
        return;
      }
      var d = Date.now() - timers[key];
      delete timers[key];
      emit(out, key + ': ' + duration(d));
    },
    timeLog: function (name) {
      var key = label(name);
      if (timers[key] === undefined) {
        emit(err, "Warning: No such label '" + key + "' for console.timeLog()");
        return;
      }
      var d = Date.now() - timers[key];
      var extra = Array.prototype.slice.call(arguments, 1);
      emit(out, key + ': ' + duration(d) + (extra.length > 0 ? ' ' + formatArgs(extra) : ''));
    },
    clear: function () {
      out('[2J[3J[H');
    },
    table: function (data, columns) {
      table(data, columns);
    },
  };

  function Console() {
    return console;
  }
  Console.prototype = console;
  console.Console = Console;

  Object.defineProperty(globalThis, 'console', {
    value: console,
    writable: true,
    enumerable: false,
    configurable: true,
  });
});
