/**
 * @fileoverview File (WHATWG File API), a Blob with a name and a lastModified
 * stamp — node's lib/internal/file.js. Re-exported from node:buffer, which also
 * installs the `File` global.
 *
 * @module lava/internal/file
 */

(function (require, module, _exports) {
  'use strict';

  var Blob = require('internal/blob').Blob;
  var StringG = String;

  /**
   * A Blob with a name and a lastModified stamp.
   * @extends Blob
   * @node A class extending Blob, like node's: File.prototype is non-writable and
   *   Object.getPrototypeOf(File) is Blob (node 26.13.0, verified).
   * @deviates Calling it without `new` throws JSC's class-constructor TypeError —
   *   `Cannot call a class constructor File without |new|` — where node says
   *   `Class constructor File cannot be invoked without 'new'` (and Lava said
   *   `Constructor File requires 'new'` before the class conversion). Pinned by
   *   cmd/lava/blob_class_test.odin.
   */
  class File extends Blob {
    /**
     * @param {Iterable<*>} parts
     * @param {string} name
     * @param {{type?: string, endings?: string, lastModified?: number}} [options]
     */
    constructor(parts, name, options) {
      if (arguments.length < 2)
        throw new TypeError(
          "Failed to construct 'File': 2 arguments required, but only " +
            arguments.length +
            ' present.',
        );
      super(parts, options);
      Object.defineProperty(this, '_name', { value: StringG(name) });
      var lm =
        options && options.lastModified !== undefined ? Number(options.lastModified) : Date.now();
      Object.defineProperty(this, '_lastModified', { value: lm });
    }

    get name() {
      return this._name;
    }

    get lastModified() {
      return this._lastModified;
    }
  }

  if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
    Object.defineProperty(File.prototype, Symbol.toStringTag, {
      value: 'File',
      configurable: true,
    });
  }

  module.exports = { File: File };
});
