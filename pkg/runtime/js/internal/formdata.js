/**
 * @fileoverview FormData (XHR Standard §4) and the two form encodings fetch bodies use:
 * multipart/form-data serialization (FormData as a body) and parsing, with
 * application/x-www-form-urlencoded, for Body.formData(). Installs the `FormData`
 * global at module-eval.
 *
 * The entry list lives in a private field as `{name, value}` records; a value is a
 * USVString or a File (a Blob is wrapped as a File named "blob" on the way in, as
 * Blink does). Iteration is live, as Blink's "FormData Iterator": an entry appended
 * after the iterator was made is still visited.
 *
 * Errors are Chrome 158's (tests/web/cases/formdata-basic.expected): WebIDL's argument
 * counts, `parameter 2 is not of type 'Blob'.` for the three-argument append/set, and
 * for Body.formData() the bare `Failed to fetch` Blink rejects a body it cannot parse
 * with, `Invalid MIME type` for a multipart type with no boundary.
 *
 * Instantiated eagerly (the loader names it after internal/file), so every capture
 * below is pristine.
 *
 * @module lava/internal/formdata
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var nativeShape = require('internal/native_shape');
  var webErrors = require('internal/web_errors');
  var blob = require('internal/blob');
  var file = require('internal/file');
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var ArrayPrototypeSplice = P.ArrayPrototypeSplice;
  var MathFloor = P.MathFloor;
  var MathRandom = P.Math.random;
  var ObjectCreate = P.ObjectCreate;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectGetPrototypeOf = P.ObjectGetPrototypeOf;
  var ReflectApply = P.ReflectApply;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var StringPrototypeToWellFormed = P.StringPrototypeToWellFormed;
  var StringPrototypeTrim = P.StringPrototypeTrim;
  var SymbolIterator = P.Symbol.iterator;
  var TypedArrayPrototypeSubarray = P.TypedArrayPrototypeSubarray;
  var TypeErrorP = P.TypeError;
  var WeakMapPrototypeGet = P.WeakMapPrototypeGet;
  var WeakMapPrototypeSet = P.WeakMapPrototypeSet;
  var argumentsRequired = webErrors.argumentsRequired;
  var illegalInvocation = webErrors.illegalInvocation;
  var notOfType = webErrors.notOfType;
  var pageError = webErrors.pageError;
  var toDOMString = webErrors.toDOMString;
  var typeError = webErrors.typeError;
  var isBlob = blob.isBlob;
  var utf8Encode = blob.utf8Encode;
  var utf8Decode = blob.utf8Decode;
  var entryFile = file.entryFile;
  var fileFromBytes = file.fileFromBytes;
  // %IteratorPrototype%, the [[Prototype]] of Blink's iterator prototypes.
  var IteratorPrototype = ObjectGetPrototypeOf(ObjectGetPrototypeOf([][SymbolIterator]()));

  var IFACE = 'FormData';
  var BOUNDARY_PREFIX = '----WebKitFormBoundary';
  var BOUNDARY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  // WebIDL's USVString: ToString (a Symbol throws Blink's text), lone surrogates to U+FFFD.
  function toUSVString(value, op) {
    return StringPrototypeToWellFormed(toDOMString(value, IFACE, op));
  }

  // Brand readers, assigned in the static block below.
  var isFormData;
  var listOf;

  // The (name, value[, filename]) conversion append() and set() share: the
  // three-argument overload takes a Blob only; with two, a Blob is a Blob and anything
  // else a USVString. Converted in argument order.
  function convertEntry(op, args) {
    var n = args.length;
    if (n < 2) throw typeError(IFACE, op, argumentsRequired(2, n));
    var name = toUSVString(args[0], op);
    var value = args[1];
    if (n >= 3 || isBlob(value)) {
      if (!isBlob(value)) throw typeError(IFACE, op, notOfType(2, 'Blob'));
      var filename = args[2] === undefined ? undefined : toUSVString(args[2], op);
      return { __proto__: null, name: name, value: entryFile(value, filename) };
    }

    return { __proto__: null, name: name, value: toUSVString(value, op) };
  }

  function requireName(op, args) {
    if (args.length < 1) throw typeError(IFACE, op, argumentsRequired(1, 0));
    return toUSVString(args[0], op);
  }

  /**
   * FormData (XHR Standard). `new FormData()` only: Larva has no HTMLFormElement.
   * @throws {TypeError} `Failed to construct 'FormData': parameter 1 is not of type
   *   'HTMLFormElement'.` for any `form` but undefined.
   * @node n/a — Chrome 158, tests/web/cases/formdata-basic.expected and
   *   shape-fetch.expected.
   * @deviates A form element is refused rather than read: Larva's DOM has no
   *   HTMLFormElement yet (the same text Chrome throws for a non-form).
   */
  class FormData {
    #list = [];

    constructor(form) {
      if (form !== undefined) {
        throw typeError(IFACE, undefined, notOfType(1, 'HTMLFormElement'));
      }
    }

    static {
      isFormData = function (o) {
        return typeof o === 'object' && o !== null && #list in o;
      };
      listOf = function (o) {
        if (!isFormData(o)) throw illegalInvocation();
        return o.#list;
      };
    }

    append(name, value) {
      var list = listOf(this);
      ArrayPrototypePush1(list, convertEntry('append', arguments));
    }

    delete(name) {
      var list = listOf(this);
      var n = requireName('delete', arguments);
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i].name === n) ArrayPrototypeSplice(list, i, 1);
      }
    }

    get(name) {
      var list = listOf(this);
      var n = requireName('get', arguments);
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === n) return list[i].value;
      }

      return null;
    }

    getAll(name) {
      var list = listOf(this);
      var n = requireName('getAll', arguments);
      var out = [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === n) out[out.length] = list[i].value;
      }

      return out;
    }

    has(name) {
      var list = listOf(this);
      var n = requireName('has', arguments);
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === n) return true;
      }

      return false;
    }

    // Replaces the first entry named `name` and drops the rest, or appends.
    set(name, value) {
      var list = listOf(this);
      var entry = convertEntry('set', arguments);
      var found = false;
      for (var i = 0; i < list.length;) {
        if (list[i].name !== entry.name) {
          i++;
        } else if (found) {
          ArrayPrototypeSplice(list, i, 1);
        } else {
          list[i] = entry;
          found = true;
          i++;
        }
      }

      if (!found) ArrayPrototypePush1(list, entry);
    }

    entries() {
      listOf(this);
      return newIterator(this, KIND_ENTRIES);
    }

    // The callback sees entries appended during the walk (the length is re-read).
    forEach(callback, thisArg) {
      var list = listOf(this);
      if (arguments.length < 1) throw typeError(IFACE, 'forEach', argumentsRequired(1, 0));
      if (typeof callback !== 'function') {
        throw typeError(IFACE, 'forEach', notOfType(1, 'Function'));
      }

      for (var i = 0; i < list.length; i++) {
        ReflectApply(callback, thisArg, [list[i].value, list[i].name, this]);
      }
    }

    keys() {
      listOf(this);
      return newIterator(this, KIND_KEYS);
    }

    values() {
      listOf(this);
      return newIterator(this, KIND_VALUES);
    }
  }

  // --- the "FormData Iterator" ------------------------------------------------------

  var KIND_KEYS = 0;
  var KIND_VALUES = 1;
  var KIND_ENTRIES = 2;
  var iteratorStates = new P.WeakMap();

  function iteratorNext() {
    var state = WeakMapPrototypeGet(iteratorStates, this);
    if (state === undefined) throw illegalInvocation();
    var list = listOf(state.target);
    if (state.index >= list.length) return { value: undefined, done: true };
    var entry = list[state.index++];
    var value;
    if (state.kind === KIND_KEYS) value = entry.name;
    else if (state.kind === KIND_VALUES) value = entry.value;
    else value = [entry.name, entry.value];
    return { value: value, done: false };
  }

  var ITERATOR_PROTO = ObjectCreate(IteratorPrototype);
  ObjectDefineProperty(ITERATOR_PROTO, 'next', {
    __proto__: null,
    value: nativeShape.wrapOperation('next', iteratorNext, 0),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  ObjectDefineProperty(ITERATOR_PROTO, P.SymbolToStringTag, {
    __proto__: null,
    value: 'FormData Iterator',
    writable: false,
    enumerable: false,
    configurable: true,
  });

  function newIterator(target, kind) {
    var it = ObjectCreate(ITERATOR_PROTO);
    WeakMapPrototypeSet(iteratorStates, it, {
      __proto__: null,
      target: target,
      kind: kind,
      index: 0,
    });
    return it;
  }

  // --- multipart/form-data serialization ---------------------------------------------

  // HTML's multipart/form-data escaping of a name or filename: LF, CR and '"' as %0A,
  // %0D and %22 (Chrome 158 sends `name="a%22b"`).
  function escapeField(s) {
    var out = '';
    var from = 0;
    for (var i = 0; i < s.length; i++) {
      var c = StringPrototypeCharCodeAt(s, i);
      var esc = c === 0x0a ? '%0A' : c === 0x0d ? '%0D' : c === 0x22 ? '%22' : null;
      if (esc !== null) {
        out += StringPrototypeSlice(s, from, i) + esc;
        from = i + 1;
      }
    }

    return from === 0 ? s : out + StringPrototypeSlice(s, from, s.length);
  }

  // Every lone CR, lone LF and CRLF as CRLF: what the encoding does to names and string
  // values before they are written (a filename keeps its own).
  function normalizeNewlines(s) {
    var out = '';
    var from = 0;
    var changed = false;
    for (var i = 0; i < s.length; i++) {
      var c = StringPrototypeCharCodeAt(s, i);
      if (c === 0x0d) {
        if (i + 1 < s.length && StringPrototypeCharCodeAt(s, i + 1) === 0x0a) {
          i++;
          continue;
        }

        out += StringPrototypeSlice(s, from, i) + '\r\n';
        from = i + 1;
        changed = true;
      } else if (c === 0x0a) {
        out += StringPrototypeSlice(s, from, i) + '\r\n';
        from = i + 1;
        changed = true;
      }
    }

    return changed ? out + StringPrototypeSlice(s, from, s.length) : s;
  }

  function newBoundary() {
    var b = BOUNDARY_PREFIX;
    for (var i = 0; i < 16; i++)
      b += BOUNDARY_CHARS[MathFloor(MathRandom() * BOUNDARY_CHARS.length)];
    return b;
  }

  /**
   * The fetch standard's "extract a body" for a FormData: its multipart/form-data
   * encoding under a fresh boundary, and the Content-Type that names it.
   * @param {*} body
   * @returns {{bytes: Uint8Array, type: string}|null} null when `body` is no FormData.
   * @node n/a — Chrome 158, tests/web/cases/formdata-basic.expected: Blink's
   *   `----WebKitFormBoundary` + 16 alphanumerics, a part per entry, a file part with
   *   its filename and Content-Type (application/octet-stream when it has none).
   * @deviates none
   */
  function extractFormData(body) {
    if (!isFormData(body)) return null;
    var list = listOf(body);
    var boundary = newBoundary();
    // Strings and Blobs, joined to bytes by internal/blob (UTF-8 for the strings).
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      var head =
        '--' +
        boundary +
        '\r\nContent-Disposition: form-data; name="' +
        escapeField(normalizeNewlines(entry.name)) +
        '"';
      if (typeof entry.value === 'string') {
        ArrayPrototypePush1(parts, head + '\r\n\r\n' + normalizeNewlines(entry.value) + '\r\n');
        continue;
      }

      var type = blob.typeOf(entry.value);
      ArrayPrototypePush1(
        parts,
        head +
          '; filename="' +
          escapeField(fileName(entry.value)) +
          '"\r\nContent-Type: ' +
          (type === '' ? 'application/octet-stream' : type) +
          '\r\n\r\n',
      );
      ArrayPrototypePush1(parts, entry.value);
      ArrayPrototypePush1(parts, '\r\n');
    }

    ArrayPrototypePush1(parts, '--' + boundary + '--\r\n');
    var joined = new blob.BlobImpl(blob.buildChunks(parts, false), undefined, blob.INTERNAL, '');
    return {
      __proto__: null,
      bytes: blob.blobBytes(joined),
      type: 'multipart/form-data; boundary=' + boundary,
    };
  }

  // Every non-string entry is a File (entryFile).
  function fileName(f) {
    return file.fileName(f);
  }

  // --- Body.formData() -----------------------------------------------------------------

  function failedToFetch() {
    return pageError(new TypeErrorP('Failed to fetch'));
  }

  // A MIME type's essence and its `boundary` parameter (quotes removed), enough of the
  // MIME Sniffing parser for the two types formData() reads.
  function parseMime(value) {
    var semi = StringPrototypeIndexOf(value, ';', 0);
    var essence = StringPrototypeToLowerCase(
      StringPrototypeTrim(semi === -1 ? value : StringPrototypeSlice(value, 0, semi)),
    );
    var boundary = null;
    var rest = semi === -1 ? '' : StringPrototypeSlice(value, semi + 1, value.length);
    var params = parseParams(rest);
    for (var i = 0; i < params.length; i++) {
      if (StringPrototypeToLowerCase(params[i].key) === 'boundary') {
        boundary = params[i].value;
        break;
      }
    }

    return { __proto__: null, essence: essence, boundary: boundary };
  }

  // `key=value` pairs separated by ';', a value optionally in double quotes.
  function parseParams(text) {
    var out = [];
    var i = 0;
    var n = text.length;
    while (i < n) {
      var semi = StringPrototypeIndexOf(text, ';', i);
      var end = semi === -1 ? n : semi;
      var eq = StringPrototypeIndexOf(text, '=', i);
      if (eq !== -1 && eq < end) {
        var key = StringPrototypeTrim(StringPrototypeSlice(text, i, eq));
        var value = StringPrototypeTrim(StringPrototypeSlice(text, eq + 1, end));
        if (
          value.length >= 2 &&
          StringPrototypeCharCodeAt(value, 0) === 0x22 &&
          StringPrototypeCharCodeAt(value, value.length - 1) === 0x22
        ) {
          value = StringPrototypeSlice(value, 1, value.length - 1);
        }

        ArrayPrototypePush1(out, { __proto__: null, key: key, value: value });
      }

      i = end + 1;
    }

    return out;
  }

  // The first index at or after `from` where `needle` (bytes) occurs in `bytes`, or -1.
  function indexOfBytes(bytes, needle, from) {
    var n = bytes.length;
    var m = needle.length;
    outer: for (var i = from; i + m <= n; i++) {
      for (var j = 0; j < m; j++) {
        if (bytes[i + j] !== needle[j]) continue outer;
      }

      return i;
    }

    return -1;
  }

  var CRLF_CRLF = utf8Encode('\r\n\r\n');

  // The headers of one part, as a lowercased-name table.
  function parseHeaders(text) {
    var headers = { __proto__: null };
    var i = 0;
    while (i < text.length) {
      var eol = StringPrototypeIndexOf(text, '\r\n', i);
      var end = eol === -1 ? text.length : eol;
      var colon = StringPrototypeIndexOf(text, ':', i);
      if (colon === -1 || colon > end) throw failedToFetch();
      var name = StringPrototypeToLowerCase(
        StringPrototypeTrim(StringPrototypeSlice(text, i, colon)),
      );
      headers[name] = StringPrototypeTrim(StringPrototypeSlice(text, colon + 1, end));
      i = end + 2;
    }

    return headers;
  }

  // multipart/form-data parsing (RFC 7578, as Blink accepts it): a preamble may precede
  // the first delimiter, every delimiter line ends in CRLF, every part has a
  // `Content-Disposition: form-data` with a name, and the body must end in the close
  // delimiter. A part with a filename is a File (text/plain without a Content-Type),
  // any other a UTF-8 string. Anything else is the `Failed to fetch` rejection.
  function parseMultipart(fd, bytes, boundary) {
    var delimiter = utf8Encode('--' + boundary);
    var nextDelimiter = utf8Encode('\r\n--' + boundary);
    var pos = indexOfBytes(bytes, delimiter, 0);
    if (pos === -1) throw failedToFetch();
    pos += delimiter.length;
    for (;;) {
      if (bytes[pos] === 0x2d && bytes[pos + 1] === 0x2d) return;
      if (bytes[pos] !== 0x0d || bytes[pos + 1] !== 0x0a) throw failedToFetch();
      pos += 2;
      var headEnd = indexOfBytes(bytes, CRLF_CRLF, pos);
      if (headEnd === -1) throw failedToFetch();
      var headers = parseHeaders(utf8Decode(TypedArrayPrototypeSubarray(bytes, pos, headEnd)));
      var bodyStart = headEnd + 4;
      var bodyEnd = indexOfBytes(bytes, nextDelimiter, bodyStart);
      if (bodyEnd === -1) throw failedToFetch();
      var disposition = headers['content-disposition'];
      if (disposition === undefined) throw failedToFetch();
      var semi = StringPrototypeIndexOf(disposition, ';', 0);
      var kind = StringPrototypeTrim(
        semi === -1 ? disposition : StringPrototypeSlice(disposition, 0, semi),
      );
      if (StringPrototypeToLowerCase(kind) !== 'form-data') throw failedToFetch();
      var name = null;
      var filename = null;
      var params = parseParams(
        semi === -1 ? '' : StringPrototypeSlice(disposition, semi + 1, disposition.length),
      );
      for (var i = 0; i < params.length; i++) {
        var key = StringPrototypeToLowerCase(params[i].key);
        if (key === 'name') name = params[i].value;
        else if (key === 'filename') filename = params[i].value;
      }

      if (name === null) throw failedToFetch();
      var content = TypedArrayPrototypeSubarray(bytes, bodyStart, bodyEnd);
      var value;
      if (filename !== null) {
        var type = headers['content-type'];
        value = fileFromBytes(
          copyBytes(content),
          filename,
          type === undefined ? 'text/plain' : type,
        );
      } else {
        value = utf8Decode(content);
      }

      ArrayPrototypePush1(listOf(fd), { __proto__: null, name: name, value: value });
      pos = bodyEnd + nextDelimiter.length;
    }
  }

  // A part's bytes outlive the body they were cut from, so a File holds its own copy.
  function copyBytes(view) {
    var out = new P.Uint8Array(view.length);
    for (var i = 0; i < view.length; i++) out[i] = view[i];
    return out;
  }

  /**
   * The fetch standard's formData() over a consumed body.
   * @param {Uint8Array|null} bytes
   * @param {string|null} contentType The body's Content-Type header.
   * @returns {FormData}
   * @throws {TypeError} `Invalid MIME type` for a multipart type with no boundary (or
   *   no body); `Failed to fetch` for another type or a body that does not parse.
   * @node n/a — Chrome 158, tests/web/cases/formdata-basic.expected.
   * @deviates A multipart part's headers are decoded as UTF-8 and its name taken as
   *   written (no RFC 2231 `name*=`), as Blink.
   */
  function parseBody(bytes, contentType) {
    var mime = parseMime(contentType === null ? '' : contentType);
    var fd = new FormData();
    if (mime.essence === 'multipart/form-data') {
      if (mime.boundary === null || mime.boundary === '' || bytes === null || bytes === undefined) {
        throw pageError(new TypeErrorP('Invalid MIME type'));
      }

      parseMultipart(fd, bytes, mime.boundary);
      return fd;
    }

    if (mime.essence === 'application/x-www-form-urlencoded') {
      var text = bytes === null || bytes === undefined ? '' : utf8Decode(bytes);
      var pairs = require('internal/url').formUrlencodedParse(text);
      var list = listOf(fd);
      for (var i = 0; i < pairs.length; i++) {
        ArrayPrototypePush1(list, { __proto__: null, name: pairs[i][0], value: pairs[i][1] });
      }

      return fd;
    }

    throw failedToFetch();
  }

  // The interface object a page sees (internal/native_shape), in Blink's member order
  // (Chrome 158, tests/web/cases/formdata-basic.expected).
  nativeShape.defineInterface({
    name: 'FormData',
    impl: FormData,
    length: 0,
    members: [
      'append:2',
      'delete:1',
      'get:1',
      'getAll:1',
      'has:1',
      'set:2',
      'entries:0',
      'forEach:1',
      'keys:0',
      'values:0',
      'constructor',
      '@@toStringTag',
      '@@iterator=entries',
    ],
  });

  module.exports = P.ObjectFreeze({
    __proto__: null,
    isFormData: isFormData,
    extractFormData: extractFormData,
    parseBody: parseBody,
  });
});
