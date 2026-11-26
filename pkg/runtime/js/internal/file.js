/**
 * @fileoverview File (WHATWG File API), a Blob with a name and a lastModified
 * stamp — node's lib/internal/file.js. Re-exported from node:buffer. Installs the
 * `File` global itself, right after internal/blob.js installs `Blob`.
 *
 * @module lava/internal/file
 */

(function (require, module, _exports) {
  'use strict';

  var P = require('internal/primordials');
  var defineInterface = require('internal/native_shape').defineInterface;
  var Blob = require('internal/blob').Blob;
  var StringG = P.String;
  var NumberG = P.Number;
  var TypeErrorG = P.TypeError;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  // Eager like internal/blob (node/buffer.js requires both before user code), so this
  // module-eval capture is pristine; primordials has no Date.
  var DateNow = Date.now;
  var DateG = Date;

  /**
   * A Blob with a name and a lastModified stamp.
   * @extends Blob
   * @node Chrome 158's shape, built by internal/native_shape around this class
   *   (tests/web/cases/shape-blob.expected): the interface object's [[Prototype]] is
   *   Blob's, File.prototype's is Blob.prototype.
   * @deviates none in shape. Instances carry non-enumerable `_name`/`_lastModified` own
   *   properties (S4c).
   */
  class File extends Blob {
    /**
     * @param {Iterable<*>} parts
     * @param {string} name
     * @param {{type?: string, endings?: string, lastModified?: number}} [options]
     */
    constructor(parts, name, options) {
      if (arguments.length < 2)
        throw new TypeErrorG(
          "Failed to construct 'File': 2 arguments required, but only " +
            arguments.length +
            ' present.',
        );
      super(parts, options);
      ObjectDefineProperty(this, '_name', { value: StringG(name) });
      var lm =
        options && options.lastModified !== undefined ? NumberG(options.lastModified) : DateNow();
      ObjectDefineProperty(this, '_lastModified', { value: lm });
    }

    get name() {
      return this._name;
    }

    get lastModified() {
      return this._lastModified;
    }

    // HTML's legacy `new Date(lastModified)`, a fresh Date per read, as Chrome's.
    get lastModifiedDate() {
      return new DateG(this._lastModified);
    }

    // Always '' for a constructed File: only a directory upload sets it.
    get webkitRelativePath() {
      return '';
    }
  }

  // The interface object a page sees (internal/native_shape), in Blink's member order
  // (Chrome 158, tests/web/cases/shape-blob.expected).
  var PublicFile = defineInterface({
    name: 'File',
    impl: File,
    length: 2,
    parent: Blob,
    members: [
      'name',
      'lastModified',
      'lastModifiedDate',
      'webkitRelativePath',
      'constructor',
      '@@toStringTag',
    ],
  });

  module.exports = { File: PublicFile };
});
