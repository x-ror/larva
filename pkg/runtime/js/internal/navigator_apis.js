/**
 * @fileoverview The objects navigator's members return — navigator.permissions,
 * userAgentData, plugins, connection, mediaDevices, locks, storage, … and
 * screen.orientation — with the interfaces Chrome exposes for them (#8). The
 * interfaces are installed at module-eval, so `typeof Permissions` is 'function' as in
 * Chrome; the objects are made by `create`, which internal/navigator calls once with
 * its natives (the client profile, pkg/profile).
 *
 * What a fingerprinting script reads is real and comes from the profile: the
 * userAgentData brands and high-entropy values, plugins and mimeTypes (Chrome's five
 * PDF viewer entries, while the profile's pdfViewerEnabled holds), connection,
 * permissions.query states, storage quota, cpuPerformance. Everything with no Larva
 * counterpart (devices, sensors, clipboard, service workers, XR, WebGPU adapters) is
 * a stub that answers as Chrome 158 headless does on a machine without that hardware
 * or permission — an empty list, a rejection with Blink's error, a promise a prompt
 * nobody answers would leave pending. Each member's @deviates says which.
 *
 * Every interface here is built by `api`: a prototype written as an object literal
 * (getters and operations, in Blink's order), re-laid by internal/native_shape. An
 * instance carries one private record (`recOf`): which interface it is — the brand
 * every member checks — and its state. Event handler attributes (`onchange`, …) are
 * generated from the member list.
 *
 * What it costs: every page installs the 38 interfaces, which Chrome conformance needs
 * as globals from the first line of page code. bench/pages at N=1 (300 pages per
 * launch, -o:speed, medians of 9 interleaved launches per arm against 8ecd066, Linux
 * x64): 99 -> 74 pages/s, RSS growth per VM 34.3 -> 40.5 MB. Of a cold page start
 * (performance.now() around internal/navigator, 5 launches), 0.4 -> 4.3 ms, ~3.3 ms of
 * it this module's require (compile ~1.9 ms, the interfaces ~1.4 ms). The member
 * objects are made on first read; the interfaces cannot be (a page reads
 * `typeof Permissions` or its prototype before touching navigator).
 *
 * Instantiated eagerly (internal/navigator requires it at its top), so every capture
 * below is pristine.
 *
 * @module lava/internal/navigator_apis
 */

(function (require, module) {
  'use strict';

  var P = require('internal/primordials');
  var nativeShape = require('internal/native_shape');
  var webErrors = require('internal/web_errors');
  var eventTarget = require('internal/event_target');
  var DOMException = require('internal/domexception').DOMException;

  var ArrayPrototypeIncludes = P.ArrayPrototypeIncludes;
  var ArrayPrototypeIndexOf = P.ArrayPrototypeIndexOf;
  var ArrayPrototypePush1 = P.ArrayPrototypePush1;
  var ArrayPrototypeSplice = P.ArrayPrototypeSplice;
  var ArrayIsArray = P.ArrayIsArray;
  var MathMin = P.MathMin;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectFreeze = P.ObjectFreeze;
  var ObjectSetPrototypeOf = P.ObjectSetPrototypeOf;
  var PromiseCtor = P.Promise;
  var PromiseReject = P.PromiseReject;
  var PromiseResolve = P.PromiseResolve;
  var ReflectApply = P.ReflectApply;
  var ReflectConstruct = P.ReflectConstruct;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeStartsWith = P.StringPrototypeStartsWith;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var TypeErrorP = P.TypeError;
  var ArrayBufferIsView = P.ArrayBufferIsView;
  var TypedArrayPrototypeGetByteLength = P.TypedArrayPrototypeGetByteLength;
  var PromiseThen = P.Promise.prototype.then;
  var ArrayValues = P.Array.prototype.values;
  var SetCtor = P.Set;
  var SetHas = P.Set.prototype.has;
  var SetValues = P.Set.prototype.values;
  var SetEntries = P.Set.prototype.entries;
  var SetForEach = P.Set.prototype.forEach;
  var SetSize = P.ObjectGetOwnPropertyDescriptor(P.Set.prototype, 'size').get;
  var ArrayBufferByteLength = P.ObjectGetOwnPropertyDescriptor(
    P.ArrayBuffer.prototype,
    'byteLength',
  ).get;
  var SymbolIterator = P.Symbol.iterator;
  var ObjectProto = P.Object.prototype;

  var EventTargetImpl = eventTarget.EventTargetImpl;
  var PublicEventTarget = eventTarget.EventTarget;
  var attachHandler = eventTarget.attachHandler;
  var detachHandler = eventTarget.detachHandler;
  var context = webErrors.context;
  var attributeContext = webErrors.attributeContext;
  var argumentsRequired = webErrors.argumentsRequired;
  var notOfType = webErrors.notOfType;
  var toDOMString = webErrors.toDOMString;
  var toNumber = webErrors.toNumber;
  var illegalInvocation = webErrors.illegalInvocation;
  var pageError = webErrors.pageError;

  var INTERNAL = { __proto__: null };
  var EMPTY = [];

  var plainRecord;
  var targetRecord;

  // The two instance classes every interface here constructs through (ReflectConstruct
  // with the interface's holder as new.target, so the instance's prototype is the
  // interface prototype). One holds a record for a plain interface, the other for an
  // EventTarget one; a page reaches neither class.
  class PlainInstance {
    #rec;

    constructor(token, rec) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      this.#rec = rec;
    }

    static {
      plainRecord = function (o) {
        return #rec in o ? o.#rec : undefined;
      };
    }
  }

  class TargetInstance extends EventTargetImpl {
    #rec;

    constructor(token, rec) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      super();
      this.#rec = rec;
    }

    static {
      targetRecord = function (o) {
        return #rec in o ? o.#rec : undefined;
      };
    }
  }

  function recOf(o) {
    if (typeof o !== 'object' || o === null) return undefined;
    var rec = plainRecord(o);
    return rec === undefined ? targetRecord(o) : rec;
  }

  // The brand check every member opens with: `self`'s record when it is an `iface`.
  function own(self, iface) {
    var rec = recOf(self);
    if (rec === undefined || rec.iface !== iface) throw illegalInvocation();
    return rec;
  }

  // Interface name -> its holder: the function whose `prototype` is the interface
  // prototype, new.target for every instance.
  var HOLDERS = { __proto__: null };

  function make(iface, state) {
    var holder = HOLDERS[iface];
    var rec = state === undefined ? { __proto__: null } : state;
    rec.iface = iface;
    rec.handlers = null;
    return ReflectConstruct(
      holder.target ? TargetInstance : PlainInstance,
      [INTERNAL, rec],
      holder,
    );
  }

  // One reader per handler type, for attachHandler: the current handler, or null.
  var READERS = { __proto__: null };

  function readerFor(type) {
    var reader = READERS[type];
    if (reader === undefined) {
      reader = function (target) {
        var handlers = recOf(target).handlers;
        var entry = handlers === null ? undefined : handlers[type];
        return entry === undefined ? null : entry.fn;
      };
      READERS[type] = reader;
    }

    return reader;
  }

  // HTML's event handler IDL attribute, as internal/xhr's: a non-function is null; the
  // listener takes its place in the list when first set and keeps it while the handler
  // changes.
  function handlerAttribute(proto, iface, attr) {
    var type = StringPrototypeSlice(attr, 2, attr.length);
    ObjectDefineProperty(proto, attr, {
      __proto__: null,
      get: function () {
        var handlers = own(this, iface).handlers;
        var entry = handlers === null ? undefined : handlers[type];
        return entry === undefined ? null : entry.fn;
      },
      set: function (fn) {
        var rec = own(this, iface);
        var value = typeof fn === 'function' ? fn : null;
        if (rec.handlers === null) rec.handlers = { __proto__: null };
        var entry = rec.handlers[type];
        if (value === null) {
          if (entry !== undefined) {
            detachHandler(this, type, entry.listener);
            delete rec.handlers[type];
          }

          return;
        }

        if (entry === undefined) {
          rec.handlers[type] = {
            __proto__: null,
            fn: value,
            listener: attachHandler(this, type, readerFor(type)),
          };
        } else {
          entry.fn = value;
        }
      },
      enumerable: true,
      configurable: true,
    });
  }

  /**
   * Installs interface `name`: `proto` (an object literal of its getters, setters and
   * operations) becomes the interface prototype, re-laid in `members` order by
   * internal/native_shape; each `on…` member without an implementation becomes an
   * event handler attribute. A page cannot construct one ("Illegal constructor").
   * @param {string} name
   * @param {boolean} target An EventTarget (its prototype chains to EventTarget's).
   * @param {string[]} members Blink's order, native_shape's entry syntax.
   * @param {Object} proto
   * @param {boolean} [global] false for an interface Blink does not expose
   *   (DeprecatedStorageQuota).
   * @returns {Object} The interface prototype.
   * @node n/a — Chrome 158, tests/web/cases/shape-navigator-apis.expected.
   * @deviates none
   */
  function api(name, target, members, proto, global) {
    var holder = function () {};
    ObjectSetPrototypeOf(proto, target ? EventTargetImpl.prototype : ObjectProto);
    var promises = PROMISE_OPERATIONS[name];
    if (promises !== undefined) {
      for (var p = 0; p < promises.length; p++) {
        proto[promises[p]] = promiseOperation(name, promises[p], proto[promises[p]]);
      }
    }

    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (StringPrototypeStartsWith(m, 'on') && !(m in proto)) handlerAttribute(proto, name, m);
    }

    holder.prototype = proto;
    holder.target = target;
    HOLDERS[name] = holder;
    nativeShape.defineInterface({
      name: name,
      impl: holder,
      length: 0,
      illegal: true,
      parent: target ? PublicEventTarget : undefined,
      members: members,
      global: global,
    });
    return proto;
  }

  // The operations that return a promise, per interface. WebIDL turns everything such
  // an operation throws into its rejection — a foreign receiver too, which Blink then
  // reports with the operation's context (navigator-apis: "Failed to execute 'query'
  // on 'Permissions': Illegal invocation"), unlike a getter's bare text.
  var PROMISE_OPERATIONS = {
    __proto__: null,
    Ink: ['requestPresenter'],
    MediaCapabilities: ['decodingInfo', 'encodingInfo'],
    Permissions: ['query'],
    Clipboard: ['read', 'readText', 'write', 'writeText'],
    CredentialsContainer: ['create', 'get', 'preventSilentAccess', 'store'],
    Keyboard: ['getLayoutMap', 'lock'],
    NavigatorManagedData: ['getManagedConfiguration'],
    MediaDevices: ['enumerateDevices', 'getUserMedia', 'getDisplayMedia'],
    ServiceWorkerContainer: ['getRegistration', 'getRegistrations', 'register'],
    WakeLock: ['request'],
    NavigatorUAData: ['getHighEntropyValues'],
    LockManager: ['query', 'request'],
    StorageManager: ['estimate', 'persisted', 'getDirectory', 'persist'],
    GPU: ['requestAdapter'],
    NavigatorLogin: ['setStatus'],
    HID: ['getDevices', 'requestDevice'],
    Serial: ['getPorts', 'requestPort'],
    USB: ['getDevices', 'requestDevice'],
    XRSystem: ['isSessionSupported', 'requestSession'],
    StorageBucketManager: ['delete', 'keys', 'open'],
    ScreenOrientation: ['lock'],
  };

  function promiseOperation(iface, op, fn) {
    return function () {
      var rec = recOf(this);
      if (rec === undefined || rec.iface !== iface) {
        return PromiseReject(typeError(iface, op, 'Illegal invocation'));
      }

      try {
        return PromiseResolve(ReflectApply(fn, this, arguments));
      } catch (e) {
        return PromiseReject(e);
      }
    };
  }

  // --- errors and promises ---------------------------------------------------------

  function typeError(iface, op, detail) {
    return pageError(new TypeErrorP(context(iface, op) + detail));
  }

  function domError(name, message) {
    return pageError(new DOMException(message, name));
  }

  function rejected(e) {
    return PromiseReject(e);
  }

  function pending() {
    return new PromiseCtor(function () {});
  }

  // Runs `fn` after the current task's microtasks start: the asynchronous answer a
  // callback API gives (Chrome posts a task; a microtask keeps the order among ours).
  function later(fn) {
    ReflectApply(PromiseThen, PromiseResolve(undefined), [fn]);
  }

  function requireArgs(iface, op, required, present) {
    if (present < required) throw typeError(iface, op, argumentsRequired(required, present));
  }

  function enumValue(value, iface, op, prefix, type, values) {
    var text = toDOMString(value, iface, op);
    if (!ArrayPrototypeIncludes(values, text)) {
      throw typeError(
        iface,
        op,
        prefix +
          "The provided value '" +
          text +
          "' is not a valid enum value of type " +
          type +
          '.',
      );
    }

    return text;
  }

  // A promise-returning operation's body: a throw becomes the rejection, as WebIDL's.
  function promised(fn, self, args) {
    try {
      return PromiseResolve(ReflectApply(fn, self, args));
    } catch (e) {
      return rejected(e);
    }
  }

  // DOMRect is not implemented (#13): the rects below are plain objects with its
  // members, all 0, as Chrome reports for a window without controls or keyboard.
  function emptyRect() {
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    };
  }

  // --- the interfaces, in shape-navigator-apis order --------------------------------

  /** @deviates isInputPending() is always false: Larva has no input. */
  api('Scheduling', false, ['isInputPending:0', 'constructor', '@@toStringTag'], {
    isInputPending() {
      own(this, 'Scheduling');
      return false;
    },
  });

  /** @deviates none: Larva never has a user activation. */
  api('UserActivation', false, ['hasBeenActive', 'isActive', 'constructor', '@@toStringTag'], {
    get hasBeenActive() {
      own(this, 'UserActivation');
      return false;
    },
    get isActive() {
      own(this, 'UserActivation');
      return false;
    },
  });

  function requireCallback(value, iface, op, index) {
    if (typeof value !== 'function') throw typeError(iface, op, notOfType(index, 'Function'));
  }

  /**
   * Geolocation. The permission is 'prompt' and nobody answers it, so neither callback
   * ever runs — what Chrome headless does too.
   * @node Chrome 158 (navigator-apis): watchPosition ids count from 1.
   * @deviates none observable: no position is ever reported.
   */
  api(
    'Geolocation',
    false,
    ['clearWatch:1', 'getCurrentPosition:1', 'watchPosition:1', 'constructor', '@@toStringTag'],
    {
      clearWatch(id) {
        own(this, 'Geolocation');
        requireArgs('Geolocation', 'clearWatch', 1, arguments.length);
        toNumber(id, 'Geolocation', 'clearWatch');
      },
      getCurrentPosition(success) {
        own(this, 'Geolocation');
        requireArgs('Geolocation', 'getCurrentPosition', 1, arguments.length);
        requireCallback(success, 'Geolocation', 'getCurrentPosition', 1);
      },
      watchPosition(success) {
        var rec = own(this, 'Geolocation');
        requireArgs('Geolocation', 'watchPosition', 1, arguments.length);
        requireCallback(success, 'Geolocation', 'watchPosition', 1);
        rec.watches = (rec.watches | 0) + 1;
        return rec.watches;
      },
    },
  );

  /** @deviates requestPresenter() rejects NotSupportedError: there is no ink trail. */
  api('Ink', false, ['requestPresenter:0', 'constructor', '@@toStringTag'], {
    requestPresenter() {
      own(this, 'Ink');
      return rejected(domError('NotSupportedError', 'Delegated ink trails are not supported.'));
    },
  });

  var DECODING_TYPES = ['file', 'media-source', 'webrtc'];
  var ENCODING_TYPES = ['webrtc'];

  function mediaInfo(self, op, types, config, present) {
    own(self, 'MediaCapabilities');
    requireArgs('MediaCapabilities', op, 1, present);
    if (typeof config !== 'object' || config === null) {
      throw typeError('MediaCapabilities', op, notOfType(1, 'MediaDecodingConfiguration'));
    }

    var type = config.type;
    if (type === undefined) {
      throw typeError(
        'MediaCapabilities',
        op,
        "Failed to read the 'type' property from 'MediaConfiguration': Required member is undefined.",
      );
    }

    enumValue(
      type,
      'MediaCapabilities',
      op,
      '',
      op === 'decodingInfo' ? 'MediaDecodingType' : 'MediaEncodingType',
      types,
    );
    var supported = config.audio != null || config.video != null;
    return {
      powerEfficient: false,
      smooth: supported,
      supported: supported,
      keySystemAccess: null,
    };
  }

  /**
   * MediaCapabilities.
   * @node Chrome 158 (navigator-apis): the result's keys are powerEfficient, smooth,
   *   supported, keySystemAccess; encodingInfo takes only 'webrtc'.
   * @deviates No codec is probed: any configuration with audio or video reports
   *   supported and smooth, never powerEfficient.
   */
  api(
    'MediaCapabilities',
    false,
    ['decodingInfo:1', 'encodingInfo:1', 'constructor', '@@toStringTag'],
    {
      decodingInfo(config) {
        return promised(mediaInfo, undefined, [
          this,
          'decodingInfo',
          DECODING_TYPES,
          config,
          arguments.length,
        ]);
      },
      encodingInfo(config) {
        return promised(mediaInfo, undefined, [
          this,
          'encodingInfo',
          ENCODING_TYPES,
          config,
          arguments.length,
        ]);
      },
    },
  );

  // What permissions.query answers for each PermissionName Blink accepts, as a fresh
  // Chrome 158 profile reports them (navigator-apis, the headless recording). Blink's
  // defaults, not the profile's: no user has granted or denied anything.
  var PERMISSION_STATES = {
    __proto__: null,
    geolocation: 'prompt',
    notifications: 'prompt',
    push: 'prompt',
    midi: 'prompt',
    camera: 'prompt',
    microphone: 'prompt',
    'background-fetch': 'granted',
    'background-sync': 'granted',
    'persistent-storage': 'prompt',
    accelerometer: 'granted',
    gyroscope: 'granted',
    magnetometer: 'granted',
    'screen-wake-lock': 'granted',
    'display-capture': 'prompt',
    'clipboard-read': 'prompt',
    'clipboard-write': 'granted',
    'payment-handler': 'granted',
    'idle-detection': 'prompt',
    'periodic-background-sync': 'denied',
    'storage-access': 'granted',
    'window-management': 'prompt',
    'local-fonts': 'prompt',
    'captured-surface-control': 'prompt',
    'keyboard-lock': 'granted',
    'pointer-lock': 'granted',
    'web-app-installation': 'prompt',
    'local-network-access': 'prompt',
    'loopback-network': 'prompt',
    'local-network': 'prompt',
  };
  // Names in the enum whose feature is off: Blink's TypeError text for each.
  var PERMISSION_DISABLED = {
    __proto__: null,
    'speaker-selection': 'The Speaker Selection API is not enabled.',
    'ambient-light-sensor': 'GenericSensorExtraClasses flag is not enabled.',
    nfc: 'Web NFC is not enabled.',
    'system-wake-lock': 'System Wake Lock is not enabled.',
  };
  var PERMISSION_DESCRIPTOR = "Failed to read the 'name' property from 'PermissionDescriptor': ";

  function queryPermission(self, descriptor, present) {
    own(self, 'Permissions');
    requireArgs('Permissions', 'query', 1, present);
    if (
      (typeof descriptor !== 'object' && typeof descriptor !== 'function') ||
      descriptor === null
    ) {
      throw typeError('Permissions', 'query', notOfType(1, 'object'));
    }

    var raw = descriptor.name;
    if (raw === undefined) {
      throw typeError(
        'Permissions',
        'query',
        PERMISSION_DESCRIPTOR + 'Required member is undefined.',
      );
    }

    var name = toDOMString(raw, 'Permissions', 'query');
    var disabled = PERMISSION_DISABLED[name];
    if (disabled !== undefined) throw typeError('Permissions', 'query', disabled);
    if (name === 'fullscreen' && descriptor.allowWithoutGesture !== true) {
      throw typeError(
        'Permissions',
        'query',
        'Fullscreen Permission only supports allowWithoutGesture:true.',
      );
    }

    var state = name === 'fullscreen' ? 'granted' : PERMISSION_STATES[name];
    if (state === undefined) {
      throw typeError(
        'Permissions',
        'query',
        PERMISSION_DESCRIPTOR +
          "The provided value '" +
          name +
          "' is not a valid enum value of type PermissionName.",
      );
    }

    if (name === 'push' && descriptor.userVisibleOnly !== true) {
      throw domError(
        'NotSupportedError',
        context('Permissions', 'query') +
          "Push Permission without userVisibleOnly:true isn't supported yet.",
      );
    }

    return make('PermissionStatus', { __proto__: null, name: name, state: state });
  }

  /**
   * Permissions.query: a new PermissionStatus each call, with a fresh profile's state.
   * @node Chrome 158 (navigator-apis): notifications/geolocation/camera 'prompt',
   *   clipboard-write 'granted', …; an unknown name rejects with the enum TypeError.
   * @deviates The state never changes, so `change` never fires. A fullscreen query
   *   with allowWithoutGesture answers 'granted' (unrecorded).
   */
  api('Permissions', false, ['query:1', 'constructor', '@@toStringTag'], {
    query(descriptor) {
      return promised(queryPermission, undefined, [this, descriptor, arguments.length]);
    },
  });

  api('PermissionStatus', true, ['name', 'state', 'onchange', 'constructor', '@@toStringTag'], {
    get name() {
      return own(this, 'PermissionStatus').name;
    },
    get state() {
      return own(this, 'PermissionStatus').state;
    },
  });

  /**
   * WindowControlsOverlay: not visible, as in any browser window without the overlay.
   * @deviates getTitlebarAreaRect() returns a plain object with DOMRect's members
   *   (DOMRect is not implemented).
   */
  api(
    'WindowControlsOverlay',
    true,
    ['visible', 'ongeometrychange', 'getTitlebarAreaRect:0', 'constructor', '@@toStringTag'],
    {
      get visible() {
        own(this, 'WindowControlsOverlay');
        return false;
      },
      getTitlebarAreaRect() {
        own(this, 'WindowControlsOverlay');
        return emptyRect();
      },
    },
  );

  // A legacy platform object's indexed and named properties: own data properties, the
  // indices enumerable, the names not (Chrome 158, navigator-apis).
  function defineItems(target, items, nameOf) {
    for (var i = 0; i < items.length; i++) {
      ObjectDefineProperty(target, i, {
        __proto__: null,
        value: items[i],
        writable: false,
        enumerable: true,
        configurable: true,
      });
    }

    for (var j = 0; j < items.length; j++) {
      ObjectDefineProperty(target, nameOf(items[j]), {
        __proto__: null,
        value: items[j],
        writable: false,
        enumerable: false,
        configurable: true,
      });
    }
  }

  function itemAt(self, iface, index, present) {
    var rec = own(self, iface);
    requireArgs(iface, 'item', 1, present);
    var i = toNumber(index, iface, 'item') >>> 0;
    return i < rec.items.length ? rec.items[i] : null;
  }

  function namedItem(self, iface, name, present, nameOf) {
    var rec = own(self, iface);
    requireArgs(iface, 'namedItem', 1, present);
    var key = toDOMString(name, iface, 'namedItem');
    for (var i = 0; i < rec.items.length; i++) {
      if (nameOf(rec.items[i]) === key) return rec.items[i];
    }

    return null;
  }

  function pluginName(p) {
    return recOf(p).name;
  }

  function mimeTypeName(m) {
    return recOf(m).type;
  }

  // @@iterator is Array.prototype.values itself, as Blink's for an indexed getter.
  function arrayIterator(proto) {
    ObjectDefineProperty(proto, SymbolIterator, {
      __proto__: null,
      value: ArrayValues,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  arrayIterator(
    api(
      'PluginArray',
      false,
      ['length', 'item:1', 'namedItem:1', 'refresh:0', 'constructor', '@@toStringTag'],
      {
        get length() {
          return own(this, 'PluginArray').items.length;
        },
        item(index) {
          return itemAt(this, 'PluginArray', index, arguments.length);
        },
        namedItem(name) {
          return namedItem(this, 'PluginArray', name, arguments.length, pluginName);
        },
        refresh() {
          own(this, 'PluginArray');
        },
      },
    ),
  );

  arrayIterator(
    api(
      'Plugin',
      false,
      [
        'name',
        'filename',
        'description',
        'length',
        'item:1',
        'namedItem:1',
        'constructor',
        '@@toStringTag',
      ],
      {
        get name() {
          return own(this, 'Plugin').name;
        },
        get filename() {
          return own(this, 'Plugin').filename;
        },
        get description() {
          return own(this, 'Plugin').description;
        },
        get length() {
          return own(this, 'Plugin').items.length;
        },
        item(index) {
          return itemAt(this, 'Plugin', index, arguments.length);
        },
        namedItem(name) {
          return namedItem(this, 'Plugin', name, arguments.length, mimeTypeName);
        },
      },
    ),
  );

  arrayIterator(
    api(
      'MimeTypeArray',
      false,
      ['length', 'item:1', 'namedItem:1', 'constructor', '@@toStringTag'],
      {
        get length() {
          return own(this, 'MimeTypeArray').items.length;
        },
        item(index) {
          return itemAt(this, 'MimeTypeArray', index, arguments.length);
        },
        namedItem(name) {
          return namedItem(this, 'MimeTypeArray', name, arguments.length, mimeTypeName);
        },
      },
    ),
  );

  api(
    'MimeType',
    false,
    ['type', 'suffixes', 'description', 'enabledPlugin', 'constructor', '@@toStringTag'],
    {
      get type() {
        return own(this, 'MimeType').type;
      },
      get suffixes() {
        return own(this, 'MimeType').suffixes;
      },
      get description() {
        return own(this, 'MimeType').description;
      },
      get enabledPlugin() {
        return own(this, 'MimeType').plugin;
      },
    },
  );

  /**
   * NetworkInformation: the profile's connection. Desktop Chrome has no `type` or
   * `downlinkMax`.
   * @deviates The values never change, so `change` never fires.
   */
  api(
    'NetworkInformation',
    true,
    ['onchange', 'effectiveType', 'rtt', 'downlink', 'saveData', 'constructor', '@@toStringTag'],
    {
      get effectiveType() {
        return own(this, 'NetworkInformation').effectiveType;
      },
      get rtt() {
        return own(this, 'NetworkInformation').rtt;
      },
      get downlink() {
        return own(this, 'NetworkInformation').downlink;
      },
      get saveData() {
        return own(this, 'NetworkInformation').saveData;
      },
    },
  );

  var PLAYBACK_STATES = ['none', 'paused', 'playing'];
  var SESSION_ACTIONS = [
    'play',
    'pause',
    'seekbackward',
    'seekforward',
    'previoustrack',
    'nexttrack',
    'skipad',
    'stop',
    'seekto',
    'togglemicrophone',
    'togglecamera',
    'hangup',
    'previousslide',
    'nextslide',
    'enterpictureinpicture',
    'voiceactivity',
  ];

  /**
   * MediaSession: state a page sets for the platform's media controls, which Larva
   * does not have.
   * @node Chrome 158 (navigator-apis): an unknown playbackState is ignored; metadata
   *   takes only null (or a MediaMetadata).
   * @deviates MediaMetadata is not implemented, so metadata only ever holds null;
   *   action handlers are stored and never called.
   */
  api(
    'MediaSession',
    false,
    [
      'metadata',
      'playbackState',
      'setActionHandler:2',
      'setCameraActive:1',
      'setMicrophoneActive:1',
      'setPositionState:0',
      'constructor',
      '@@toStringTag',
    ],
    {
      get metadata() {
        own(this, 'MediaSession');
        return null;
      },
      set metadata(value) {
        own(this, 'MediaSession');
        if (value !== null && value !== undefined) {
          throw pageError(
            new TypeErrorP(
              attributeContext('MediaSession', 'metadata', true) +
                "Failed to convert value to 'MediaMetadata'.",
            ),
          );
        }
      },
      get playbackState() {
        return own(this, 'MediaSession').playbackState || 'none';
      },
      set playbackState(value) {
        var rec = own(this, 'MediaSession');
        var text = toDOMString(value, 'MediaSession');
        if (ArrayPrototypeIncludes(PLAYBACK_STATES, text)) rec.playbackState = text;
      },
      setActionHandler(action, handler) {
        own(this, 'MediaSession');
        requireArgs('MediaSession', 'setActionHandler', 2, arguments.length);
        enumValue(
          action,
          'MediaSession',
          'setActionHandler',
          '',
          'MediaSessionAction',
          SESSION_ACTIONS,
        );
        if (handler !== null && handler !== undefined) {
          requireCallback(handler, 'MediaSession', 'setActionHandler', 2);
        }
      },
      setCameraActive(_active) {
        own(this, 'MediaSession');
        requireArgs('MediaSession', 'setCameraActive', 1, arguments.length);
      },
      setMicrophoneActive(_active) {
        own(this, 'MediaSession');
        requireArgs('MediaSession', 'setMicrophoneActive', 1, arguments.length);
      },
      setPositionState() {
        own(this, 'MediaSession');
      },
    },
  );

  function clipboardDenied(self, op, required, present, what) {
    own(self, 'Clipboard');
    requireArgs('Clipboard', op, required, present);
    throw domError('NotAllowedError', context('Clipboard', op) + what + ' permission denied.');
  }

  /**
   * Clipboard: read permission is 'prompt' and write needs a focused document, so every
   * operation rejects NotAllowedError, as in Chrome headless.
   * @node Chrome 158 (navigator-apis): "Read permission denied." / "Write permission
   *   denied."
   * @deviates none
   */
  api(
    'Clipboard',
    true,
    [
      'onclipboardchange',
      'read:0',
      'readText:0',
      'write:1',
      'writeText:1',
      'constructor',
      '@@toStringTag',
    ],
    {
      read() {
        return promised(clipboardDenied, undefined, [this, 'read', 0, arguments.length, 'Read']);
      },
      readText() {
        return promised(clipboardDenied, undefined, [
          this,
          'readText',
          0,
          arguments.length,
          'Read',
        ]);
      },
      write(_data) {
        return promised(clipboardDenied, undefined, [this, 'write', 1, arguments.length, 'Write']);
      },
      writeText(_data) {
        return promised(clipboardDenied, undefined, [
          this,
          'writeText',
          1,
          arguments.length,
          'Write',
        ]);
      },
    },
  );

  var CREDENTIAL_TYPES = ['password', 'federated', 'publicKey', 'identity', 'otp', 'digital'];

  function hasCredentialType(options) {
    if (typeof options !== 'object' || options === null) return false;
    for (var i = 0; i < CREDENTIAL_TYPES.length; i++) {
      if (options[CREDENTIAL_TYPES[i]]) return true;
    }

    return false;
  }

  /**
   * CredentialsContainer: no credential is ever stored, so get() of a known type
   * resolves null.
   * @node Chrome 158 (navigator-apis): get({password: true}) is null; create() with no
   *   type rejects NotSupportedError.
   * @deviates create() and store() of a well-formed credential reject NotSupportedError
   *   (no credential manager).
   */
  api(
    'CredentialsContainer',
    false,
    ['create:0', 'get:0', 'preventSilentAccess:0', 'store:1', 'constructor', '@@toStringTag'],
    {
      create() {
        own(this, 'CredentialsContainer');
        return rejected(
          domError(
            'NotSupportedError',
            "Only exactly one of 'password', 'federated', and 'publicKey' credential types are currently supported.",
          ),
        );
      },
      get(options) {
        own(this, 'CredentialsContainer');
        if (!hasCredentialType(options)) {
          return rejected(
            domError('NotSupportedError', 'No credential type was specified in the request.'),
          );
        }

        return PromiseResolve(null);
      },
      preventSilentAccess() {
        own(this, 'CredentialsContainer');
        return PromiseResolve(undefined);
      },
      store(_credential) {
        own(this, 'CredentialsContainer');
        if (arguments.length < 1) {
          return rejected(typeError('CredentialsContainer', 'store', argumentsRequired(1, 0)));
        }

        return rejected(domError('NotSupportedError', 'The credential manager is not available.'));
      },
    },
  );

  /**
   * Keyboard.
   * @deviates getLayoutMap() rejects NotSupportedError: KeyboardLayoutMap is not
   *   implemented (Chrome resolves one). lock()/unlock() succeed and do nothing.
   */
  api('Keyboard', false, ['getLayoutMap:0', 'lock:0', 'unlock:0', 'constructor', '@@toStringTag'], {
    getLayoutMap() {
      own(this, 'Keyboard');
      return rejected(domError('NotSupportedError', 'The keyboard layout is not available.'));
    },
    lock() {
      own(this, 'Keyboard');
      return PromiseResolve(undefined);
    },
    unlock() {
      own(this, 'Keyboard');
    },
  });

  /** @node Chrome 158 (navigator-apis): a page that is not a managed app is refused. */
  api(
    'NavigatorManagedData',
    true,
    ['onmanagedconfigurationchange', 'getManagedConfiguration:1', 'constructor', '@@toStringTag'],
    {
      getManagedConfiguration(_keys) {
        own(this, 'NavigatorManagedData');
        if (arguments.length < 1) {
          return rejected(
            typeError('NavigatorManagedData', 'getManagedConfiguration', argumentsRequired(1, 0)),
          );
        }

        return rejected(
          domError(
            'NotAllowedError',
            'Managed configuration is empty. This API is available only for managed apps.',
          ),
        );
      },
    },
  );

  // MediaTrackSupportedConstraints as Chrome 158 reports it (navigator-apis), in its
  // (lexicographic) dictionary order.
  var SUPPORTED_CONSTRAINTS = [
    'aspectRatio',
    'autoGainControl',
    'brightness',
    'channelCount',
    'colorTemperature',
    'contrast',
    'deviceId',
    'displaySurface',
    'echoCancellation',
    'exposureCompensation',
    'exposureMode',
    'exposureTime',
    'facingMode',
    'focusDistance',
    'focusMode',
    'frameRate',
    'groupId',
    'height',
    'iso',
    'latency',
    'noiseSuppression',
    'pan',
    'pointsOfInterest',
    'resizeMode',
    'restrictOwnAudio',
    'sampleRate',
    'sampleSize',
    'saturation',
    'sharpness',
    'suppressLocalAudioPlayback',
    'tilt',
    'torch',
    'voiceIsolation',
    'whiteBalanceMode',
    'width',
    'zoom',
  ];

  // getUserMedia's answer on a machine without devices: a request for neither audio
  // nor video is a TypeError, anything else NotFoundError.
  function userMediaError(iface, op, constraints) {
    var wants =
      typeof constraints === 'object' &&
      constraints !== null &&
      (!!constraints.audio || !!constraints.video);
    if (!wants) return typeError(iface, op, 'At least one of audio and video must be requested');
    return domError('NotFoundError', 'Requested device not found');
  }

  /**
   * MediaDevices: a machine with no camera, microphone or speaker.
   * @node Chrome 158 headless (navigator-apis): enumerateDevices() is [], getUserMedia
   *   rejects NotFoundError, getDisplayMedia waits on a prompt nobody answers.
   * @deviates none for a device-less host; a desktop with devices would list them.
   */
  api(
    'MediaDevices',
    true,
    [
      'ondevicechange',
      'enumerateDevices:0',
      'getSupportedConstraints:0',
      'getUserMedia:0',
      'getDisplayMedia:0',
      'setCaptureHandleConfig:0',
      'constructor',
      '@@toStringTag',
    ],
    {
      enumerateDevices() {
        own(this, 'MediaDevices');
        return PromiseResolve([]);
      },
      getSupportedConstraints() {
        own(this, 'MediaDevices');
        var out = {};
        for (var i = 0; i < SUPPORTED_CONSTRAINTS.length; i++) out[SUPPORTED_CONSTRAINTS[i]] = true;
        return out;
      },
      getUserMedia(constraints) {
        own(this, 'MediaDevices');
        return rejected(userMediaError('MediaDevices', 'getUserMedia', constraints));
      },
      getDisplayMedia() {
        own(this, 'MediaDevices');
        return pending();
      },
      setCaptureHandleConfig() {
        own(this, 'MediaDevices');
      },
    },
  );

  /**
   * ServiceWorkerContainer: Larva runs no service worker, so nothing is ever
   * registered and nothing controls the page.
   * @node Chrome 158 (navigator-apis): controller null, getRegistration() undefined,
   *   getRegistrations() [], `ready` one promise that waits for a registration.
   * @deviates register() rejects InvalidStateError at once, where Chrome fetches the
   *   script and rejects (or installs) on its answer.
   */
  api(
    'ServiceWorkerContainer',
    true,
    [
      'controller',
      'ready',
      'oncontrollerchange',
      'onmessage',
      'onmessageerror',
      'getRegistration:0',
      'getRegistrations:0',
      'register:1',
      'startMessages:0',
      'constructor',
      '@@toStringTag',
    ],
    {
      get controller() {
        own(this, 'ServiceWorkerContainer');
        return null;
      },
      get ready() {
        var rec = own(this, 'ServiceWorkerContainer');
        if (rec.ready === undefined) rec.ready = pending();
        return rec.ready;
      },
      getRegistration() {
        own(this, 'ServiceWorkerContainer');
        return PromiseResolve(undefined);
      },
      getRegistrations() {
        own(this, 'ServiceWorkerContainer');
        return PromiseResolve([]);
      },
      register(scriptURL) {
        own(this, 'ServiceWorkerContainer');
        if (arguments.length < 1) {
          return rejected(typeError('ServiceWorkerContainer', 'register', argumentsRequired(1, 0)));
        }

        try {
          toDOMString(scriptURL, 'ServiceWorkerContainer', 'register');
        } catch (e) {
          return rejected(e);
        }

        return rejected(
          domError(
            'InvalidStateError',
            'Failed to register a ServiceWorker: The document is in an invalid state.',
          ),
        );
      },
      startMessages() {
        own(this, 'ServiceWorkerContainer');
      },
    },
  );

  /**
   * VirtualKeyboard: there is none.
   * @deviates boundingRect is a plain object with DOMRect's members (DOMRect is not
   *   implemented); show()/hide() do nothing.
   */
  api(
    'VirtualKeyboard',
    true,
    [
      'boundingRect',
      'overlaysContent',
      'ongeometrychange',
      'hide:0',
      'show:0',
      'constructor',
      '@@toStringTag',
    ],
    {
      get boundingRect() {
        own(this, 'VirtualKeyboard');
        return emptyRect();
      },
      get overlaysContent() {
        return own(this, 'VirtualKeyboard').overlays === true;
      },
      set overlaysContent(value) {
        own(this, 'VirtualKeyboard').overlays = !!value;
      },
      hide() {
        own(this, 'VirtualKeyboard');
      },
      show() {
        own(this, 'VirtualKeyboard');
      },
    },
  );

  /**
   * WakeLock.
   * @deviates request() rejects NotAllowedError (the page is never visible to a user),
   *   where Chrome resolves a WakeLockSentinel; WakeLockSentinel is not implemented.
   */
  api('WakeLock', false, ['request:0', 'constructor', '@@toStringTag'], {
    request(type) {
      own(this, 'WakeLock');
      try {
        if (type !== undefined) {
          enumValue(type, 'WakeLock', 'request', '', 'WakeLockType', ['screen']);
        }
      } catch (e) {
        return rejected(e);
      }

      return rejected(domError('NotAllowedError', 'The requesting page is not visible'));
    },
  });

  // The UA-CH dictionary members, in UADataValues' (lexicographic) order.
  var HIGH_ENTROPY = [
    'architecture',
    'bitness',
    'brands',
    'formFactors',
    'fullVersionList',
    'mobile',
    'model',
    'platform',
    'platformVersion',
    'uaFullVersion',
    'wow64',
  ];

  // A NavigatorUABrandVersion list: new plain objects in a new frozen array, as each
  // Chrome read makes (navigator-apis: `brands === brands` is false).
  function brandList(ua, full) {
    var list = [];
    for (var i = 0; i < ua.brands.length; i++) {
      var b = ua.brands[i];
      list[i] = { brand: b.brand, version: full ? b.fullVersion : b.version };
    }

    return ObjectFreeze(list);
  }

  function lowEntropy(ua) {
    return { brands: brandList(ua, false), mobile: ua.mobile, platform: ua.platform };
  }

  function highEntropyValue(ua, hint) {
    switch (hint) {
      case 'architecture':
        return ua.architecture;
      case 'bitness':
        return ua.bitness;
      case 'brands':
        return brandList(ua, false);
      case 'formFactors':
        return ObjectFreeze(P.ArrayPrototypeSlice(ua.formFactors, 0));
      case 'fullVersionList':
        return brandList(ua, true);
      case 'mobile':
        return ua.mobile;
      case 'model':
        return ua.model;
      case 'platform':
        return ua.platform;
      case 'platformVersion':
        return ua.platformVersion;
      case 'uaFullVersion':
        return ua.fullVersion;
      case 'wow64':
        return ua.wow64;
    }
  }

  function getHighEntropyValues(self, hints, present) {
    var ua = own(self, 'NavigatorUAData').ua;
    requireArgs('NavigatorUAData', 'getHighEntropyValues', 1, present);
    if ((typeof hints !== 'object' && typeof hints !== 'function') || hints === null) {
      throw typeError(
        'NavigatorUAData',
        'getHighEntropyValues',
        'The provided value cannot be converted to a sequence.',
      );
    }

    // sequence<DOMString>: WebIDL iterates the value through its @@iterator, which a
    // page may define, so this is the spec's for…of and not a captured loop.
    var wanted = { __proto__: null, brands: true, mobile: true, platform: true };
    for (var hint of hints)
      wanted[toDOMString(hint, 'NavigatorUAData', 'getHighEntropyValues')] = true;
    var out = {};
    for (var i = 0; i < HIGH_ENTROPY.length; i++) {
      var key = HIGH_ENTROPY[i];
      if (wanted[key] === true) out[key] = highEntropyValue(ua, key);
    }

    return out;
  }

  /**
   * NavigatorUAData: User-Agent Client Hints, from the profile (pkg/profile UA_Data).
   * @node Chrome 158 (navigator-apis): a new object on each navigator.userAgentData
   *   read, a new frozen brands array on each brands read; getHighEntropyValues
   *   answers the low-entropy three plus the hints asked for, keys in lexicographic
   *   order, ignoring unknown hints.
   * @deviates none. The brand list is the profile's (Chrome's three-brand GREASE for
   *   158), where a headless recording reports Chromium's two.
   */
  api(
    'NavigatorUAData',
    false,
    [
      'brands',
      'mobile',
      'platform',
      'getHighEntropyValues:1',
      'toJSON:0',
      'constructor',
      '@@toStringTag',
    ],
    {
      get brands() {
        return brandList(own(this, 'NavigatorUAData').ua, false);
      },
      get mobile() {
        return own(this, 'NavigatorUAData').ua.mobile;
      },
      get platform() {
        return own(this, 'NavigatorUAData').ua.platform;
      },
      getHighEntropyValues(hints) {
        return promised(getHighEntropyValues, undefined, [this, hints, arguments.length]);
      },
      toJSON() {
        return lowEntropy(own(this, 'NavigatorUAData').ua);
      },
    },
  );

  // --- Web Locks ---------------------------------------------------------------------

  // The page's lock state: held locks and queued requests, each a record {name, mode,
  // callback, resolve, reject, lock}. One page, one agent, so no cross-tab arbitration.
  var held = [];
  var queued = [];
  var LOCK_MODES = ['exclusive', 'shared'];

  function heldConflicts(name, mode) {
    for (var i = 0; i < held.length; i++) {
      var h = held[i];
      if (h.name === name && (mode === 'exclusive' || h.mode === 'exclusive')) return true;
    }

    return false;
  }

  function queuedFor(name) {
    for (var i = 0; i < queued.length; i++) {
      if (queued[i].name === name) return true;
    }

    return false;
  }

  function settleWith(req, fn, arg) {
    var result;
    try {
      result = ReflectApply(fn, undefined, [arg]);
    } catch (e) {
      req.reject(e);
      return null;
    }

    return PromiseResolve(result);
  }

  function grant(req) {
    ArrayPrototypePush1(held, req);
    req.lock = make('Lock', { __proto__: null, name: req.name, mode: req.mode });
    later(function () {
      var done = settleWith(req, req.callback, req.lock);
      if (done === null) {
        release(req);
        return;
      }

      ReflectApply(PromiseThen, done, [
        function (value) {
          release(req);
          req.resolve(value);
        },
        function (reason) {
          release(req);
          req.reject(reason);
        },
      ]);
    });
  }

  function release(req) {
    var at = ArrayPrototypeIndexOf(held, req);
    if (at !== -1) ArrayPrototypeSplice(held, at, 1);
    // Grant the queue's front for this name while it is compatible with what is held.
    for (var i = 0; i < queued.length;) {
      var next = queued[i];
      if (next.name !== req.name) {
        i++;
        continue;
      }

      if (heldConflicts(next.name, next.mode)) break;
      ArrayPrototypeSplice(queued, i, 1);
      grant(next);
    }
  }

  function lockInfo(req) {
    return { clientId: clientId(), mode: req.mode, name: req.name };
  }

  var CLIENT_ID = null;

  // The page's client id, a UUID made on first need (internal/crypto/random's is the
  // pristine one).
  function clientId() {
    if (CLIENT_ID === null) CLIENT_ID = require('internal/crypto/random').randomUUID();
    return CLIENT_ID;
  }

  function requestLock(args) {
    var count = args.length;
    requireArgs('LockManager', 'request', 2, count);
    var name = toDOMString(args[0], 'LockManager', 'request');
    var options = count > 2 ? args[1] : undefined;
    var callback = count > 2 ? args[2] : args[1];
    var mode = 'exclusive';
    var ifAvailable = false;
    var steal = false;
    var signal;
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object' && typeof options !== 'function') {
        throw typeError('LockManager', 'request', notOfType(2, 'LockOptions'));
      }

      ifAvailable = !!options.ifAvailable;
      var rawMode = options.mode;
      if (rawMode !== undefined) {
        mode = enumValue(
          rawMode,
          'LockManager',
          'request',
          "Failed to read the 'mode' property from 'LockOptions': ",
          'LockMode',
          LOCK_MODES,
        );
      }

      signal = options.signal;
      steal = !!options.steal;
    }

    requireCallback(callback, 'LockManager', 'request', count > 2 ? 3 : 2);
    var prefix = context('LockManager', 'request');
    if (StringPrototypeStartsWith(name, '-')) {
      throw domError('NotSupportedError', prefix + "Names cannot start with '-'.");
    }

    if (steal && ifAvailable) {
      throw domError(
        'NotSupportedError',
        prefix + "The 'steal' and 'ifAvailable' options cannot be used together.",
      );
    }

    if (steal && mode !== 'exclusive') {
      throw domError(
        'NotSupportedError',
        prefix + "The 'steal' option may only be used with 'exclusive' locks.",
      );
    }

    if (signal !== undefined && steal) {
      throw domError(
        'NotSupportedError',
        prefix + "The 'signal' and 'steal' options cannot be used together.",
      );
    }

    if (signal !== undefined && ifAvailable) {
      throw domError(
        'NotSupportedError',
        prefix + "The 'signal' and 'ifAvailable' options cannot be used together.",
      );
    }

    return new PromiseCtor(function (resolve, reject) {
      var req = {
        __proto__: null,
        name: name,
        mode: mode,
        callback: callback,
        resolve: resolve,
        reject: reject,
        lock: null,
      };
      if (steal || (!queuedFor(name) && !heldConflicts(name, mode))) {
        grant(req);
      } else if (ifAvailable) {
        later(function () {
          var done = settleWith(req, callback, null);
          if (done !== null) ReflectApply(PromiseThen, done, [resolve, reject]);
        });
      } else {
        ArrayPrototypePush1(queued, req);
      }
    });
  }

  /**
   * LockManager: Web Locks within the page — exclusive and shared modes, ifAvailable,
   * a FIFO queue per name, the callback's result settling request()'s promise.
   * @node Chrome 158 (navigator-apis): a held lock's request waits; ifAvailable gets
   *   null; query() lists LockInfo {clientId, mode, name}.
   * @deviates The callback runs in a microtask, where Chrome posts a task. `signal` is
   *   validated but never aborts a queued request, and `steal` grants without
   *   releasing the stolen lock. No arbitration across pages (each page is its own
   *   agent).
   */
  api('LockManager', false, ['query:0', 'request:2', 'constructor', '@@toStringTag'], {
    query() {
      own(this, 'LockManager');
      var h = [];
      var q = [];
      for (var i = 0; i < held.length; i++) h[i] = lockInfo(held[i]);
      for (var j = 0; j < queued.length; j++) q[j] = lockInfo(queued[j]);
      return PromiseResolve({ held: h, pending: q });
    },
    request(_name, _callback) {
      try {
        own(this, 'LockManager');
        return requestLock(arguments);
      } catch (e) {
        return rejected(e);
      }
    },
  });

  api('Lock', false, ['name', 'mode', 'constructor', '@@toStringTag'], {
    get name() {
      return own(this, 'Lock').name;
    },
    get mode() {
      return own(this, 'Lock').mode;
    },
  });

  /**
   * StorageManager: the profile's quota, nothing used, never persisted.
   * @node Chrome 158 (navigator-apis): estimate() is {quota, usage, usageDetails};
   *   persist() resolves false without site engagement.
   * @deviates usage is always 0 (localStorage is not counted). getDirectory() rejects
   *   SecurityError: the origin-private file system is not implemented.
   */
  api(
    'StorageManager',
    false,
    ['estimate:0', 'persisted:0', 'constructor', 'getDirectory:0', 'persist:0', '@@toStringTag'],
    {
      estimate() {
        var rec = own(this, 'StorageManager');
        return PromiseResolve({ quota: rec.quota, usage: 0, usageDetails: {} });
      },
      persisted() {
        own(this, 'StorageManager');
        return PromiseResolve(false);
      },
      getDirectory() {
        own(this, 'StorageManager');
        return rejected(domError('SecurityError', 'Security error when calling GetDirectory'));
      },
      persist() {
        own(this, 'StorageManager');
        return PromiseResolve(false);
      },
    },
  );

  // WGSL language extensions Chrome 158 reports (navigator-apis), in its order.
  var WGSL_FEATURES = [
    'packed_4x8_integer_dot_product',
    'subgroup_uniformity',
    'immediate_address_space',
    'linear_indexing',
    'subgroup_id',
    'readonly_and_readwrite_storage_textures',
    'swizzle_assignment',
    'unrestricted_pointer_parameters',
    'buffer_view',
    'pointer_composite_access',
    'texture_and_sampler_let',
    'texture_formats_tier1',
    'uniform_buffer_standard_layout',
  ];

  /**
   * GPU: WebGPU with no adapter, which is what Chrome answers on a host without a
   * usable GPU.
   * @node Chrome 158 (navigator-apis): requestAdapter() resolves null,
   *   getPreferredCanvasFormat() is 'rgba8unorm' on Linux.
   * @deviates none for a GPU-less host.
   */
  api(
    'GPU',
    false,
    [
      'wgslLanguageFeatures',
      'getPreferredCanvasFormat:0',
      'requestAdapter:0',
      'constructor',
      '@@toStringTag',
    ],
    {
      get wgslLanguageFeatures() {
        var rec = own(this, 'GPU');
        if (rec.features === undefined) {
          rec.features = make('WGSLLanguageFeatures', {
            __proto__: null,
            set: new SetCtor(WGSL_FEATURES),
          });
        }

        return rec.features;
      },
      getPreferredCanvasFormat() {
        own(this, 'GPU');
        return 'rgba8unorm';
      },
      requestAdapter() {
        own(this, 'GPU');
        return PromiseResolve(null);
      },
    },
  );

  /**
   * WGSLLanguageFeatures: a read-only setlike.
   * @deviates Its iterators are Set iterators (`[object Set Iterator]`), where Blink's
   *   are `[object WGSLLanguageFeatures Iterator]`.
   */
  api(
    'WGSLLanguageFeatures',
    false,
    [
      'size',
      'entries:0',
      'forEach:1',
      'has:1',
      'keys:0',
      'values:0',
      'constructor',
      '@@toStringTag',
      '@@iterator=values',
    ],
    {
      get size() {
        return ReflectApply(SetSize, own(this, 'WGSLLanguageFeatures').set, EMPTY);
      },
      entries() {
        return ReflectApply(SetEntries, own(this, 'WGSLLanguageFeatures').set, EMPTY);
      },
      forEach(callback, thisArg) {
        var self = this;
        var set = own(this, 'WGSLLanguageFeatures').set;
        requireArgs('WGSLLanguageFeatures', 'forEach', 1, arguments.length);
        requireCallback(callback, 'WGSLLanguageFeatures', 'forEach', 1);
        ReflectApply(SetForEach, set, [
          function (value) {
            ReflectApply(callback, thisArg, [value, value, self]);
          },
        ]);
      },
      has(value) {
        var set = own(this, 'WGSLLanguageFeatures').set;
        requireArgs('WGSLLanguageFeatures', 'has', 1, arguments.length);
        return ReflectApply(SetHas, set, [toDOMString(value, 'WGSLLanguageFeatures', 'has')]);
      },
      keys() {
        return ReflectApply(SetValues, own(this, 'WGSLLanguageFeatures').set, EMPTY);
      },
      values() {
        return ReflectApply(SetValues, own(this, 'WGSLLanguageFeatures').set, EMPTY);
      },
    },
  );

  var LOGIN_STATUSES = ['logged-in', 'logged-out'];

  /** @deviates setStatus() is accepted and has no effect (no FedCM). */
  api('NavigatorLogin', false, ['setStatus:1', 'constructor', '@@toStringTag'], {
    setStatus(status) {
      own(this, 'NavigatorLogin');
      try {
        requireArgs('NavigatorLogin', 'setStatus', 1, arguments.length);
        enumValue(status, 'NavigatorLogin', 'setStatus', '', 'LoginStatus', LOGIN_STATUSES);
      } catch (e) {
        return rejected(e);
      }

      return PromiseResolve(undefined);
    },
  });

  /** @deviates none: a desktop is 'continuous' and never folds. */
  api('DevicePosture', true, ['type', 'onchange', 'constructor', '@@toStringTag'], {
    get type() {
      own(this, 'DevicePosture');
      return 'continuous';
    },
  });

  function gestureRequired(iface, op) {
    return domError(
      'SecurityError',
      context(iface, op) + 'Must be handling a user gesture to show a permission request.',
    );
  }

  /**
   * HID, USB, Serial: no device is ever paired, and a chooser needs a user gesture
   * Larva never has.
   * @node Chrome 158 (navigator-apis): getDevices()/getPorts() are [];
   *   requestDevice()/requestPort() reject SecurityError.
   * @deviates none
   */
  api(
    'HID',
    true,
    [
      'onconnect',
      'ondisconnect',
      'getDevices:0',
      'constructor',
      'requestDevice:1',
      '@@toStringTag',
    ],
    {
      getDevices() {
        own(this, 'HID');
        return PromiseResolve([]);
      },
      requestDevice(_options) {
        own(this, 'HID');
        if (arguments.length < 1) {
          return rejected(typeError('HID', 'requestDevice', argumentsRequired(1, 0)));
        }

        return rejected(gestureRequired('HID', 'requestDevice'));
      },
    },
  );

  /**
   * Presentation: no presentation display.
   * @deviates PresentationRequest is not implemented, so defaultRequest only holds null.
   */
  api('Presentation', false, ['defaultRequest', 'receiver', 'constructor', '@@toStringTag'], {
    get defaultRequest() {
      own(this, 'Presentation');
      return null;
    },
    set defaultRequest(value) {
      own(this, 'Presentation');
      if (value !== null && value !== undefined) {
        throw pageError(
          new TypeErrorP(
            attributeContext('Presentation', 'defaultRequest', true) +
              "Failed to convert value to 'PresentationRequest'.",
          ),
        );
      }
    },
    get receiver() {
      own(this, 'Presentation');
      return null;
    },
  });

  api(
    'Serial',
    true,
    ['onconnect', 'ondisconnect', 'getPorts:0', 'constructor', 'requestPort:0', '@@toStringTag'],
    {
      getPorts() {
        own(this, 'Serial');
        return PromiseResolve([]);
      },
      requestPort() {
        own(this, 'Serial');
        return rejected(gestureRequired('Serial', 'requestPort'));
      },
    },
  );

  api(
    'USB',
    true,
    [
      'onconnect',
      'ondisconnect',
      'getDevices:0',
      'constructor',
      'requestDevice:1',
      '@@toStringTag',
    ],
    {
      getDevices() {
        own(this, 'USB');
        return PromiseResolve([]);
      },
      requestDevice(_options) {
        own(this, 'USB');
        if (arguments.length < 1) {
          return rejected(typeError('USB', 'requestDevice', argumentsRequired(1, 0)));
        }

        return rejected(gestureRequired('USB', 'requestDevice'));
      },
    },
  );

  var XR_MODES = ['inline', 'immersive-vr', 'immersive-ar'];

  /**
   * XRSystem: no XR device; only 'inline' sessions are supported.
   * @node Chrome 158 (navigator-apis): isSessionSupported('inline') true,
   *   'immersive-vr' false; requestSession needs a user activation.
   * @deviates none
   */
  api(
    'XRSystem',
    true,
    ['ondevicechange', 'isSessionSupported:1', 'requestSession:1', 'constructor', '@@toStringTag'],
    {
      isSessionSupported(mode) {
        own(this, 'XRSystem');
        try {
          requireArgs('XRSystem', 'isSessionSupported', 1, arguments.length);
          var m = enumValue(mode, 'XRSystem', 'isSessionSupported', '', 'XRSessionMode', XR_MODES);
          return PromiseResolve(m === 'inline');
        } catch (e) {
          return rejected(e);
        }
      },
      requestSession(mode) {
        own(this, 'XRSystem');
        try {
          requireArgs('XRSystem', 'requestSession', 1, arguments.length);
          enumValue(mode, 'XRSystem', 'requestSession', '', 'XRSessionMode', XR_MODES);
        } catch (e) {
          return rejected(e);
        }

        return rejected(
          domError(
            'SecurityError',
            context('XRSystem', 'requestSession') +
              'The requested session requires user activation.',
          ),
        );
      },
    },
  );

  /**
   * StorageBucketManager: no bucket exists.
   * @deviates open() rejects NotSupportedError: StorageBucket is not implemented.
   */
  api(
    'StorageBucketManager',
    false,
    ['delete:1', 'keys:0', 'open:1', 'constructor', '@@toStringTag'],
    {
      delete(name) {
        own(this, 'StorageBucketManager');
        try {
          requireArgs('StorageBucketManager', 'delete', 1, arguments.length);
          toDOMString(name, 'StorageBucketManager', 'delete');
        } catch (e) {
          return rejected(e);
        }

        return PromiseResolve(undefined);
      },
      keys() {
        own(this, 'StorageBucketManager');
        return PromiseResolve([]);
      },
      open(_name) {
        own(this, 'StorageBucketManager');
        if (arguments.length < 1) {
          return rejected(typeError('StorageBucketManager', 'open', argumentsRequired(1, 0)));
        }

        return rejected(domError('NotSupportedError', 'Storage buckets are not supported.'));
      },
    },
  );

  /**
   * BatteryManager: the Battery Status spec's values for a host with no battery
   * (charging, full, chargingTime 0, dischargingTime Infinity) — a plugged-in desktop.
   * @deviates The values never change, so no event fires.
   */
  api(
    'BatteryManager',
    true,
    [
      'charging',
      'chargingTime',
      'dischargingTime',
      'level',
      'onchargingchange',
      'onchargingtimechange',
      'ondischargingtimechange',
      'onlevelchange',
      'constructor',
      '@@toStringTag',
    ],
    {
      get charging() {
        own(this, 'BatteryManager');
        return true;
      },
      get chargingTime() {
        own(this, 'BatteryManager');
        return 0;
      },
      get dischargingTime() {
        own(this, 'BatteryManager');
        return Infinity;
      },
      get level() {
        own(this, 'BatteryManager');
        return 1;
      },
    },
  );

  var ORIENTATION_LOCKS = [
    'any',
    'natural',
    'landscape',
    'portrait',
    'portrait-primary',
    'portrait-secondary',
    'landscape-primary',
    'landscape-secondary',
  ];

  /**
   * ScreenOrientation: the profile screen's orientation, which never changes.
   * @node Chrome 158 (navigator-apis): a desktop reports 'landscape-primary' at angle
   *   0; lock() rejects NotSupportedError, unlock() does nothing.
   * @deviates none
   */
  api(
    'ScreenOrientation',
    true,
    ['angle', 'type', 'onchange', 'lock:1', 'unlock:0', 'constructor', '@@toStringTag'],
    {
      get angle() {
        own(this, 'ScreenOrientation');
        return 0;
      },
      get type() {
        return own(this, 'ScreenOrientation').type;
      },
      lock(orientation) {
        own(this, 'ScreenOrientation');
        try {
          requireArgs('ScreenOrientation', 'lock', 1, arguments.length);
          enumValue(
            orientation,
            'ScreenOrientation',
            'lock',
            '',
            'OrientationLockType',
            ORIENTATION_LOCKS,
          );
        } catch (e) {
          return rejected(e);
        }

        return rejected(
          domError(
            'NotSupportedError',
            'screen.orientation.lock() is not available on this device.',
          ),
        );
      },
      unlock() {
        own(this, 'ScreenOrientation');
      },
    },
  );

  /**
   * DeprecatedStorageQuota (navigator.webkitTemporaryStorage, webkitPersistentStorage —
   * one object, as in Chrome): the legacy quota callbacks over the profile's quota. Not
   * exposed as a global, and its prototype has no `constructor`.
   * @node Chrome 158 (navigator-apis): queryUsageAndQuota calls back with two numbers.
   * @deviates usage is always 0; requestQuota grants up to the profile's quota.
   */
  api(
    'DeprecatedStorageQuota',
    false,
    ['queryUsageAndQuota:1', 'requestQuota:1', '@@toStringTag'],
    {
      queryUsageAndQuota(success, _error) {
        var rec = own(this, 'DeprecatedStorageQuota');
        requireArgs('DeprecatedStorageQuota', 'queryUsageAndQuota', 1, arguments.length);
        requireCallback(success, 'DeprecatedStorageQuota', 'queryUsageAndQuota', 1);
        later(function () {
          ReflectApply(success, undefined, [0, rec.quota]);
        });
      },
      requestQuota(newQuota, success, _error) {
        var rec = own(this, 'DeprecatedStorageQuota');
        requireArgs('DeprecatedStorageQuota', 'requestQuota', 1, arguments.length);
        var granted = MathMin(
          toNumber(newQuota, 'DeprecatedStorageQuota', 'requestQuota'),
          rec.quota,
        );
        if (typeof success === 'function') {
          later(function () {
            ReflectApply(success, undefined, [granted]);
          });
        }
      },
    },
    false,
  );

  // --- Navigator's operations ---------------------------------------------------------

  // sendBeacon's payload limit: Chrome refuses a beacon whose body exceeds 64 KiB.
  var BEACON_LIMIT = 65536;

  function utf8Length(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = StringPrototypeCharCodeAt(s, i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        n += 4;
        i++;
      } else n += 3;
    }

    return n;
  }

  function payloadSize(data) {
    if (typeof data === 'string') return utf8Length(data);
    if (ArrayBufferIsView(data)) return TypedArrayPrototypeGetByteLength(data);
    try {
      return ReflectApply(ArrayBufferByteLength, data, EMPTY);
    } catch {
      return 0;
    }
  }

  function swallow() {}

  /**
   * Navigator.sendBeacon: queues a POST of `data` to `url` (resolved against the
   * document) through fetch with keepalive, and answers whether it was queued.
   * @node Chrome 158 (navigator-apis): a non-HTTP(S) URL and an unparsable one throw
   *   TypeError; a body over 64 KiB answers false.
   * @deviates The request is an ordinary fetch: it does not outlive the page. Only a
   *   string or byte body is measured against the 64 KiB limit (a Blob or FormData is
   *   sent whatever its size).
   */
  function sendBeacon(url, data) {
    requireArgs('Navigator', 'sendBeacon', 1, arguments.length);
    var text = toDOMString(url, 'Navigator', 'sendBeacon');
    var href = require('internal/location').resolveHref(text);
    if (href === null) {
      throw typeError('Navigator', 'sendBeacon', 'The URL argument is ill-formed or unsupported.');
    }

    var lower = StringPrototypeToLowerCase(
      StringPrototypeSlice(href, 0, StringPrototypeIndexOf(href, ':', 0) + 1),
    );
    if (lower !== 'http:' && lower !== 'https:') {
      throw typeError('Navigator', 'sendBeacon', 'Beacons are only supported over HTTP(S).');
    }

    var body = beaconBody(data);
    if (body !== null && payloadSize(body) > BEACON_LIMIT) return false;
    var sent = require('internal/fetch').fetch(href, {
      __proto__: null,
      method: 'POST',
      body: body,
      keepalive: true,
      credentials: 'include',
      mode: 'no-cors',
    });
    ReflectApply(PromiseThen, sent, [swallow, swallow]);
    return true;
  }

  // BodyInit: bytes, a Blob, FormData, URLSearchParams or a stream go to fetch as
  // themselves; anything else is sent as its string, as WebIDL's union with USVString
  // converts it.
  function beaconBody(data) {
    if (data === undefined || data === null) return null;
    if (typeof data !== 'object' && typeof data !== 'function') {
      return toDOMString(data, 'Navigator', 'sendBeacon');
    }

    if (ArrayBufferIsView(data)) return data;
    try {
      ReflectApply(ArrayBufferByteLength, data, EMPTY);
      return data;
    } catch {}
    var tag = P.ObjectPrototypeToString(data);
    if (
      tag === '[object Blob]' ||
      tag === '[object File]' ||
      tag === '[object FormData]' ||
      tag === '[object URLSearchParams]' ||
      tag === '[object ReadableStream]'
    ) {
      return data;
    }

    return toDOMString(data, 'Navigator', 'sendBeacon');
  }

  var MIDI_DENIED = 'Permission to use Web MIDI API was not granted.';

  function requestMediaKeySystemAccess(keySystem, configs) {
    var op = 'requestMediaKeySystemAccess';
    requireArgs('Navigator', op, 2, arguments.length);
    var system = toDOMString(keySystem, 'Navigator', op);
    if ((typeof configs !== 'object' && typeof configs !== 'function') || configs === null) {
      throw typeError('Navigator', op, 'The provided value cannot be converted to a sequence.');
    }

    var count = 0;
    for (var _config of configs) count++;
    if (system === '') throw typeError('Navigator', op, 'The keySystem parameter is empty.');
    if (count === 0) {
      throw typeError('Navigator', op, 'The supportedConfigurations parameter is empty.');
    }

    throw domError('NotSupportedError', 'Unsupported keySystem or supportedConfigurations.');
  }

  // The scheme safelist HTML gives registerProtocolHandler, beside `web+` schemes.
  var SAFE_SCHEMES = [
    'bitcoin',
    'cabal',
    'dat',
    'did',
    'dweb',
    'ethereum',
    'ftp',
    'ftps',
    'geo',
    'im',
    'ipfs',
    'ipns',
    'irc',
    'ircs',
    'magnet',
    'mailto',
    'matrix',
    'mms',
    'news',
    'nntp',
    'openpgp4fpr',
    'sftp',
    'sip',
    'sms',
    'smsto',
    'ssb',
    'ssh',
    'tel',
    'urn',
    'webcal',
    'wtai',
    'xmpp',
  ];

  function legacyGetUserMedia(op, constraints, success, error, present) {
    requireArgs('Navigator', op, 3, present);
    requireCallback(success, 'Navigator', op, 2);
    requireCallback(error, 'Navigator', op, 3);
    var e = userMediaError('Navigator', op, constraints);
    later(function () {
      ReflectApply(error, undefined, [e]);
    });
  }

  function gamepads() {
    return [null, null, null, null, null, null, null, null];
  }

  // Navigator's promise-returning operations (PROMISE_OPERATIONS' rule).
  var NAVIGATOR_PROMISE_OPERATIONS = [
    'clearAppBadge',
    'getBattery',
    'getInstalledRelatedApps',
    'install',
    'requestMIDIAccess',
    'requestMediaKeySystemAccess',
    'setAppBadge',
  ];

  // Navigator's operations beside javaEnabled, each `fn(...)` called with the brand
  // already checked (internal/navigator).
  var OPERATIONS = {
    __proto__: null,
    getGamepads: gamepads,
    sendBeacon: sendBeacon,
    vibrate: function (_pattern) {
      requireArgs('Navigator', 'vibrate', 1, arguments.length);
      // Chrome answers false without a user activation, which Larva never has.
      return false;
    },
    clearAppBadge: function () {
      return PromiseResolve(undefined);
    },
    getUserMedia: function (constraints, success, error) {
      legacyGetUserMedia('getUserMedia', constraints, success, error, arguments.length);
    },
    requestMIDIAccess: function () {
      return rejected(domError('NotAllowedError', MIDI_DENIED));
    },
    requestMediaKeySystemAccess: function (keySystem, configs) {
      return promised(requestMediaKeySystemAccess, undefined, arguments);
    },
    setAppBadge: function () {
      return PromiseResolve(undefined);
    },
    webkitGetUserMedia: function (constraints, success, error) {
      legacyGetUserMedia('webkitGetUserMedia', constraints, success, error, arguments.length);
    },
    getInstalledRelatedApps: function () {
      return PromiseResolve([]);
    },
    install: function () {
      return rejected(
        domError(
          'NotAllowedError',
          context('Navigator', 'install') +
            'Unable to install app. This API can only be called shortly after a user activation.',
        ),
      );
    },
    registerProtocolHandler: function (scheme, url) {
      requireArgs('Navigator', 'registerProtocolHandler', 2, arguments.length);
      var s = StringPrototypeToLowerCase(
        toDOMString(scheme, 'Navigator', 'registerProtocolHandler'),
      );
      toDOMString(url, 'Navigator', 'registerProtocolHandler');
      if (!StringPrototypeStartsWith(s, 'web+') && !ArrayPrototypeIncludes(SAFE_SCHEMES, s)) {
        throw domError(
          'SecurityError',
          context('Navigator', 'registerProtocolHandler') +
            "The scheme '" +
            s +
            "' doesn't belong to the scheme allowlist. Please prefix non-allowlisted schemes with the string 'web+'.",
        );
      }
    },
    unregisterProtocolHandler: function (scheme, url) {
      requireArgs('Navigator', 'unregisterProtocolHandler', 2, arguments.length);
      toDOMString(scheme, 'Navigator', 'unregisterProtocolHandler');
      toDOMString(url, 'Navigator', 'unregisterProtocolHandler');
    },
  };

  // Chrome's built-in PDF viewer entries: every Chrome since 94 reports these five, each
  // with the same two MIME types (Chrome 158, navigator-apis).
  var PDF_PLUGINS = [
    'PDF Viewer',
    'Chrome PDF Viewer',
    'Chromium PDF Viewer',
    'Microsoft Edge PDF Viewer',
    'WebKit built-in PDF',
  ];
  var PDF_TYPES = ['application/pdf', 'text/pdf'];
  var PDF_DESCRIPTION = 'Portable Document Format';

  function mimeTypesFor(plugin) {
    var list = [];
    for (var i = 0; i < PDF_TYPES.length; i++) {
      list[i] = make('MimeType', {
        __proto__: null,
        type: PDF_TYPES[i],
        suffixes: 'pdf',
        description: PDF_DESCRIPTION,
        plugin: plugin,
      });
    }

    return list;
  }

  function makePlugins(enabled) {
    var plugins = [];
    if (enabled) {
      for (var i = 0; i < PDF_PLUGINS.length; i++) {
        var rec = {
          __proto__: null,
          name: PDF_PLUGINS[i],
          filename: 'internal-pdf-viewer',
          description: PDF_DESCRIPTION,
          items: EMPTY,
        };
        var plugin = make('Plugin', rec);
        rec.items = mimeTypesFor(plugin);
        defineItems(plugin, rec.items, mimeTypeName);
        plugins[i] = plugin;
      }
    }

    var pluginArray = make('PluginArray', { __proto__: null, items: plugins });
    defineItems(pluginArray, plugins, pluginName);
    var mimes = enabled ? mimeTypesFor(plugins[0]) : [];
    var mimeTypeArray = make('MimeTypeArray', { __proto__: null, items: mimes });
    defineItems(mimeTypeArray, mimes, mimeTypeName);
    return { __proto__: null, plugins: pluginArray, mimeTypes: mimeTypeArray };
  }

  function uaData(native) {
    var flat = native.uaBrands;
    var brands = [];
    for (var i = 0; i + 2 < flat.length; i += 3) {
      brands[brands.length] = {
        __proto__: null,
        brand: flat[i],
        version: flat[i + 1],
        fullVersion: flat[i + 2],
      };
    }

    return {
      __proto__: null,
      brands: brands,
      mobile: native.uaMobile,
      platform: native.uaPlatform,
      platformVersion: native.uaPlatformVersion,
      architecture: native.uaArchitecture,
      bitness: native.uaBitness,
      model: native.uaModel,
      fullVersion: native.uaFullVersion,
      wow64: native.uaWow64,
      formFactors: P.ArrayPrototypeSlice(native.uaFormFactors, 0),
    };
  }

  // navigator's member objects that carry no state beyond their brand: attribute ->
  // interface. Each is made on its first read (`once`): most pages read none of them,
  // and making them all up front measured 0.75 ms of each page's start (bin/lava run
  // of an empty page, performance.now() around create(), median of 3 launches).
  var PLAIN_MEMBERS = {
    __proto__: null,
    scheduling: 'Scheduling',
    userActivation: 'UserActivation',
    geolocation: 'Geolocation',
    ink: 'Ink',
    mediaCapabilities: 'MediaCapabilities',
    permissions: 'Permissions',
    windowControlsOverlay: 'WindowControlsOverlay',
    mediaSession: 'MediaSession',
    clipboard: 'Clipboard',
    credentials: 'CredentialsContainer',
    keyboard: 'Keyboard',
    managed: 'NavigatorManagedData',
    mediaDevices: 'MediaDevices',
    serviceWorker: 'ServiceWorkerContainer',
    virtualKeyboard: 'VirtualKeyboard',
    wakeLock: 'WakeLock',
    locks: 'LockManager',
    gpu: 'GPU',
    login: 'NavigatorLogin',
    devicePosture: 'DevicePosture',
    hid: 'HID',
    presentation: 'Presentation',
    serial: 'Serial',
    usb: 'USB',
    xr: 'XRSystem',
    storageBuckets: 'StorageBucketManager',
  };

  // `build` deferred to the first call; the same value on every call after.
  function once(build) {
    var value;
    var built = false;
    return function () {
      if (!built) {
        value = build();
        built = true;
      }

      return value;
    };
  }

  function plainMember(iface) {
    return once(function () {
      return make(iface);
    });
  }

  /**
   * Makes the page's navigator member objects from the client profile, each on first
   * read.
   * @param {Object} native internal/navigator's natives (pkg/runtime/window_env.odin).
   * @returns {Object} `attributes` (name -> getter of the value, brand unchecked),
   *   `operations` (name -> implementation), `promiseOperations` (the names of those
   *   that return a promise) and `orientation` (screen.orientation's getter).
   */
  function create(native) {
    var quota = native.storageQuota;
    var pdf = native.pdfViewerEnabled === true;
    var ua = null;
    var battery = null;
    var attributes = { __proto__: null };
    for (var key in PLAIN_MEMBERS) attributes[key] = plainMember(PLAIN_MEMBERS[key]);
    // One object for both, as Chrome's (navigator-apis).
    attributes.webkitTemporaryStorage = once(function () {
      return make('DeprecatedStorageQuota', { __proto__: null, quota: quota });
    });
    attributes.webkitPersistentStorage = attributes.webkitTemporaryStorage;
    var lists = once(function () {
      return makePlugins(pdf);
    });
    attributes.plugins = function () {
      return lists().plugins;
    };
    attributes.mimeTypes = function () {
      return lists().mimeTypes;
    };
    attributes.connection = once(function () {
      return make('NetworkInformation', {
        __proto__: null,
        effectiveType: native.connectionEffectiveType,
        rtt: native.connectionRtt,
        downlink: native.connectionDownlink,
        saveData: native.connectionSaveData,
      });
    });
    attributes.storage = once(function () {
      return make('StorageManager', { __proto__: null, quota: quota });
    });
    attributes.pdfViewerEnabled = constant(pdf);
    attributes.globalPrivacyControl = constant(false);
    attributes.cpuPerformance = constant(native.cpuPerformance);
    // A new NavigatorUAData on each read, as Chrome's (navigator-apis).
    attributes.userAgentData = function () {
      if (ua === null) ua = uaData(native);
      return make('NavigatorUAData', { __proto__: null, ua: ua });
    };

    var operations = { __proto__: null };
    for (var op in OPERATIONS) operations[op] = OPERATIONS[op];
    // One promise for the page, as Chrome's getBattery().
    operations.getBattery = function () {
      if (battery === null) battery = PromiseResolve(make('BatteryManager'));
      return battery;
    };

    var landscape = native.screenWidth >= native.screenHeight;
    var orientation = once(function () {
      return make('ScreenOrientation', {
        __proto__: null,
        type: landscape ? 'landscape-primary' : 'portrait-primary',
      });
    });
    return {
      __proto__: null,
      attributes: attributes,
      operations: operations,
      promiseOperations: NAVIGATOR_PROMISE_OPERATIONS,
      orientation: orientation,
    };
  }

  function constant(value) {
    return function () {
      return value;
    };
  }

  module.exports = ObjectFreeze({ __proto__: null, create: create });
});
