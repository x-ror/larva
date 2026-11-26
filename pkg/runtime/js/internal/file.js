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
  var TypeErrorG = P.TypeError;
  var webErrors = require('internal/web_errors');
  var web = webErrors.web;
  var typeError = webErrors.typeError;
  var argumentsRequired = webErrors.argumentsRequired;
  var illegalInvocation = webErrors.illegalInvocation;
  var nodeError = require('internal/errors').nodeError;
  // Eager like internal/blob (node/buffer.js requires both before user code), so this
  // module-eval capture is pristine; primordials has no Date.
  var DateNow = Date.now;
  var DateG = Date;

  function invalidThis() {
    if (web) return illegalInvocation();
    return nodeError(TypeErrorG, 'ERR_INVALID_THIS', 'Value of "this" must be of type File');
  }

  // Bound in File's static block, the only code that can read its private fields.
  var isFile, cloneFileOf;

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
        throw web ? typeError('File', undefined, detail) : new TypeErrorG(detail);
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

  module.exports = { File: PublicFile, cloneBlobOrFile: cloneBlobOrFile };
});
