/**
 * @fileoverview File (WHATWG File API), a Blob with a name and a lastModified
 * stamp — node's lib/internal/file.js. Re-exported from node:buffer. Installs the
 * `File` global itself, right after internal/blob.js installs `Blob`.
 *
 * Its conversions are internal/blob's (the parts, the BlobPropertyBag members) with
 * the file name between them, in Blink's order; errors follow the profile as there.
 *
 * @module lava/internal/file
 */

(function (require, module, _exports) {
  'use strict';

  var P = require('internal/primordials');
  var defineInterface = require('internal/native_shape').defineInterface;
  var blob = require('internal/blob');
  var BlobImpl = blob.BlobImpl;
  var INTERNAL = blob.INTERNAL;
  var convertParts = blob.convertParts;
  var convertBag = blob.convertBag;
  var buildChunks = blob.buildChunks;
  var toStringArg = blob.toStringArg;
  var cloneBlob = blob.cloneBlob;
  var typeOfBlob = blob.typeOf;
  var partsOfBlob = blob.partsOf;
  var webErrors = require('internal/web_errors');
  var typeError = webErrors.typeError;
  var argumentsRequired = webErrors.argumentsRequired;
  var illegalInvocation = webErrors.illegalInvocation;
  // Eager like internal/blob (node/buffer.js requires both before user code), so this
  // module-eval capture is pristine; primordials has no Date.
  var DateNow = Date.now;
  var DateG = Date;

  function invalidThis() {
    return illegalInvocation();
  }

  // Bound in File's static block, the only code that can read its private fields.
  var isFile, cloneFileOf, renameFile, fileName;

  /**
   * A Blob with a name and a lastModified stamp, both in private fields.
   * @extends Blob
   * @node Chrome 158's shape, built by internal/native_shape around this class
   *   (tests/web/cases/shape-blob.expected): the interface object's [[Prototype]] is
   *   Blob's, File.prototype's is Blob.prototype. An instance has no own properties
   *   (tests/web/cases/blob-errors).
   * @deviates none
   */
  class File extends BlobImpl {
    #name;
    #lastModified;

    static {
      isFile = function (value) {
        return value !== null && typeof value === 'object' && #name in value;
      };
      // The structured-clone serialization: the same bytes, type, name and stamp.
      cloneFileOf = function (file) {
        return new File(partsOfBlob(file), file.#name, INTERNAL, {
          __proto__: null,
          type: typeOfBlob(file),
          lastModified: file.#lastModified,
        });
      };
      fileName = function (file) {
        return file.#name;
      };
      // The same bytes and type under `name`; a File keeps its stamp, a Blob gets now.
      renameFile = function (blob, name) {
        return new File(partsOfBlob(blob), name, INTERNAL, {
          __proto__: null,
          type: typeOfBlob(blob),
          lastModified: isFile(blob) ? blob.#lastModified : DateNow(),
        });
      };
    }

    /**
     * @param {Iterable<*>} parts
     * @param {string} name
     * @param {{type?: string, endings?: string, lastModified?: number}} [options]
     * @throws {TypeError} fewer than two arguments, a Symbol name, or as Blob's
     *   conversions.
     * @node Chrome 158 (tests/web/cases/blob-errors): the argument count first, then
     *       the parts, the name, and the bag's `endings`, `type`, `lastModified`; a
     *       `lastModified` is a `long long` (NaN and 2^64 are 0, fractions truncate).
     * @deviates none
     */
    constructor(parts, name, options, internal) {
      if (options === INTERNAL) {
        // A clone: `parts` is the source's chunk list, `internal` its type and stamp.
        super(parts, undefined, INTERNAL, internal.type);
        this.#name = name;
        this.#lastModified = internal.lastModified;
        return;
      }

      if (arguments.length < 2) {
        var detail = argumentsRequired(2, arguments.length);
        throw typeError('File', undefined, detail);
      }

      var list = convertParts(parts, 'File');
      var fileName = toStringArg(name, 'File', undefined, '');
      var bag = convertBag(options, 'File');
      super(buildChunks(list, bag.native), undefined, INTERNAL, bag.type);
      this.#name = fileName;
      this.#lastModified = bag.lastModified === undefined ? DateNow() : bag.lastModified;
    }

    get name() {
      if (!isFile(this)) throw invalidThis();
      return this.#name;
    }

    get lastModified() {
      if (!isFile(this)) throw invalidThis();
      return this.#lastModified;
    }

    // HTML's legacy `new Date(lastModified)`, a fresh Date per read, as Chrome's.
    get lastModifiedDate() {
      if (!isFile(this)) throw invalidThis();
      return new DateG(this.#lastModified);
    }

    // Always '' for a constructed File: only a directory upload sets it.
    get webkitRelativePath() {
      if (!isFile(this)) throw invalidThis();
      return '';
    }
  }

  // The interface object a page sees (internal/native_shape), in Blink's member order
  // (Chrome 158, tests/web/cases/shape-blob.expected).
  var PublicFile = defineInterface({
    name: 'File',
    impl: File,
    length: 2,
    parent: blob.Blob,
    members: [
      'name',
      'lastModified',
      'lastModifiedDate',
      'webkitRelativePath',
      'constructor',
      '@@toStringTag',
    ],
  });

  /**
   * The structured-clone serialization of a Blob or File (both are serializable
   * interfaces): a File keeps its name and lastModified, a Blob its bytes and type.
   * @param {*} value
   * @returns {Blob|File|undefined} undefined for anything else.
   * @node Chrome 158 (tests/web/cases/clone-transfer).
   * @deviates none
   */
  function cloneBlobOrFile(value) {
    if (isFile(value)) return cloneFileOf(value);
    return cloneBlob(value);
  }

  /**
   * The File a FormData entry holds for a Blob value (XHR's "create an entry"): a File
   * with no new name is kept as it is; a Blob, or a File given a name, becomes a new
   * File over the same bytes named `name`, else "blob".
   * @param {Blob} blob
   * @param {string|undefined} name
   * @returns {File}
   * @node n/a — Chrome 158, tests/web/cases/formdata-basic.expected (a renamed File
   *   keeps its lastModified).
   * @deviates none
   */
  function entryFile(blob, name) {
    if (isFile(blob) && name === undefined) return blob;
    return renameFile(blob, name === undefined ? 'blob' : name);
  }

  /**
   * A File over `bytes` (a parsed multipart part): stamped now.
   * @param {Uint8Array} bytes
   * @param {string} name
   * @param {string} type
   * @returns {File}
   */
  function fileFromBytes(bytes, name, type) {
    return new File(bytes.length === 0 ? [] : [bytes], name, INTERNAL, {
      __proto__: null,
      type: type,
      lastModified: DateNow(),
    });
  }

  module.exports = {
    File: PublicFile,
    cloneBlobOrFile: cloneBlobOrFile,
    // A File's name from its private field (no page-replaceable getter on the way).
    fileName: fileName,
    entryFile: entryFile,
    fileFromBytes: fileFromBytes,
  };
});
