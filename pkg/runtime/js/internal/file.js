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
  var Blob = require('internal/blob').Blob;
  var StringG = P.String;
  var NumberG = P.Number;
  var TypeErrorG = P.TypeError;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  // Eager like internal/blob (node/buffer.js requires both before user code), so this
  // module-eval capture is pristine; primordials has no Date.
  var DateNow = Date.now;

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
  }

  ObjectDefineProperty(File.prototype, P.Symbol.toStringTag, {
    value: 'File',
    configurable: true,
  });

  if (globalThis.File === undefined) {
    globalThis.File = File;
  }

  module.exports = { File: File };
});
