/**
 * @fileoverview What a page reads about the browser and the display: the `navigator`
 * (Navigator) and `screen` (Screen) globals and the window's geometry (innerWidth,
 * outerHeight, devicePixelRatio, screenX, scrollY, …), installed at module-eval (#13,
 * #14).
 *
 * Every value comes from the client profile (pkg/profile, this factory's fourth
 * argument), the table that also gives pkg/http its User-Agent, so the header and
 * navigator.userAgent are one string. The values are a plausible desktop's, the same
 * on every host — not this machine's cores or display (Larva has no display). The
 * constants every Chrome reports (appName, product, …) are Blink's and live here.
 *
 * Navigator carries every member Chrome 158 has, in Blink's order. The objects its
 * members return (permissions, userAgentData, plugins, connection, …) and
 * screen.orientation are internal/navigator_apis'.
 *
 * Instantiated eagerly (the loader names it), so every capture below is pristine.
 *
 * @module lava/internal/navigator
 */

(function (require, module, _exports, native) {
  'use strict';

  var P = require('internal/primordials');
  var nativeShape = require('internal/native_shape');
  var webErrors = require('internal/web_errors');
  var eventTarget = require('internal/event_target');
  var navigatorApis = require('internal/navigator_apis');
  var layout = require('internal/layout');
  var ArrayPrototypeIncludes = P.ArrayPrototypeIncludes;
  var ArrayPrototypeSlice = P.ArrayPrototypeSlice;
  var PromiseReject = P.PromiseReject;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectFreeze = P.ObjectFreeze;
  var ReflectApply = P.ReflectApply;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeStartsWith = P.StringPrototypeStartsWith;
  var TypeErrorP = P.TypeError;
  var EventTargetImpl = eventTarget.EventTargetImpl;
  var attachHandler = eventTarget.attachHandler;
  var detachHandler = eventTarget.detachHandler;
  var illegalInvocation = webErrors.illegalInvocation;

  // The profile, read once: the natives object is never handed to page code.
  var USER_AGENT = native.userAgent;
  var MOZILLA = 'Mozilla/';
  // navigator.appVersion: the UA without its `Mozilla/` product token, as Blink derives it.
  var APP_VERSION = StringPrototypeStartsWith(USER_AGENT, MOZILLA)
    ? StringPrototypeSlice(USER_AGENT, MOZILLA.length, USER_AGENT.length)
    : USER_AGENT;
  var PLATFORM = native.platform;
  var VENDOR = native.vendor;
  // A FrozenArray: the same frozen array on every read, as Chrome's.
  var LANGUAGES = ObjectFreeze(ArrayPrototypeSlice(native.languages, 0));
  var LANGUAGE = LANGUAGES.length > 0 ? LANGUAGES[0] : 'en-US';
  var HARDWARE_CONCURRENCY = native.hardwareConcurrency;
  var DEVICE_MEMORY = native.deviceMemory;
  var MAX_TOUCH_POINTS = native.maxTouchPoints;
  var APIS = navigatorApis.create(native);

  var INTERNAL = { __proto__: null };
  var CHANGE = 'change';

  var isNavigator;
  var isScreen;
  var readChangeHandler;

  /**
   * Navigator: the browser's identity and capabilities, from the client profile.
   * @node n/a — Chrome 158, tests/web/cases/shape-navigator.expected (shape),
   *   navigator-profile.expected (types and the relations between the values, which
   *   are the machine's in a recording) and navigator-apis.expected (what the member
   *   objects and operations answer).
   * @deviates Values are the profile's, not the host's: hardwareConcurrency,
   *   deviceMemory, cpuPerformance, connection and userAgentData are fixed, and
   *   `webdriver` is false. The member objects' stubs are listed in
   *   internal/navigator_apis.
   */
  class Navigator {
    #brand = true;

    constructor(token) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
    }

    static {
      isNavigator = function (o) {
        return typeof o === 'object' && o !== null && #brand in o;
      };
    }

    get maxTouchPoints() {
      if (!isNavigator(this)) throw illegalInvocation();
      return MAX_TOUCH_POINTS;
    }

    get doNotTrack() {
      if (!isNavigator(this)) throw illegalInvocation();
      return null;
    }

    get hardwareConcurrency() {
      if (!isNavigator(this)) throw illegalInvocation();
      return HARDWARE_CONCURRENCY;
    }

    get cookieEnabled() {
      if (!isNavigator(this)) throw illegalInvocation();
      return true;
    }

    get appCodeName() {
      if (!isNavigator(this)) throw illegalInvocation();
      return 'Mozilla';
    }

    get appName() {
      if (!isNavigator(this)) throw illegalInvocation();
      return 'Netscape';
    }

    get appVersion() {
      if (!isNavigator(this)) throw illegalInvocation();
      return APP_VERSION;
    }

    get platform() {
      if (!isNavigator(this)) throw illegalInvocation();
      return PLATFORM;
    }

    get product() {
      if (!isNavigator(this)) throw illegalInvocation();
      return 'Gecko';
    }

    get productSub() {
      if (!isNavigator(this)) throw illegalInvocation();
      return '20030107';
    }

    get userAgent() {
      if (!isNavigator(this)) throw illegalInvocation();
      return USER_AGENT;
    }

    get vendor() {
      if (!isNavigator(this)) throw illegalInvocation();
      return VENDOR;
    }

    get vendorSub() {
      if (!isNavigator(this)) throw illegalInvocation();
      return '';
    }

    get language() {
      if (!isNavigator(this)) throw illegalInvocation();
      return LANGUAGE;
    }

    get languages() {
      if (!isNavigator(this)) throw illegalInvocation();
      return LANGUAGES;
    }

    get onLine() {
      if (!isNavigator(this)) throw illegalInvocation();
      return true;
    }

    get webdriver() {
      if (!isNavigator(this)) throw illegalInvocation();
      return false;
    }

    javaEnabled() {
      if (!isNavigator(this)) throw illegalInvocation();
      return false;
    }

    get deviceMemory() {
      if (!isNavigator(this)) throw illegalInvocation();
      return DEVICE_MEMORY;
    }
  }

  // navigator_apis' attributes and operations, each behind Navigator's brand check.
  function brandedGetter(get) {
    return function () {
      if (!isNavigator(this)) throw illegalInvocation();
      return get();
    };
  }

  function brandedOperation(fn) {
    return function () {
      if (!isNavigator(this)) throw illegalInvocation();
      return ReflectApply(fn, undefined, arguments);
    };
  }

  // A promise-returning operation rejects a foreign receiver, with its context, as
  // Blink's does (internal/navigator_apis PROMISE_OPERATIONS).
  function brandedPromiseOperation(name, fn) {
    return function () {
      if (!isNavigator(this)) {
        return PromiseReject(webErrors.typeError('Navigator', name, 'Illegal invocation'));
      }

      try {
        return ReflectApply(fn, undefined, arguments);
      } catch (e) {
        return PromiseReject(e);
      }
    };
  }

  for (var attribute in APIS.attributes) {
    ObjectDefineProperty(Navigator.prototype, attribute, {
      __proto__: null,
      get: brandedGetter(APIS.attributes[attribute]),
      enumerable: true,
      configurable: true,
    });
  }

  for (var operation in APIS.operations) {
    ObjectDefineProperty(Navigator.prototype, operation, {
      __proto__: null,
      value: ArrayPrototypeIncludes(APIS.promiseOperations, operation)
        ? brandedPromiseOperation(operation, APIS.operations[operation])
        : brandedOperation(APIS.operations[operation]),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  // Blink's member order (Chrome 158, shape-navigator).
  nativeShape.defineInterface({
    name: 'Navigator',
    impl: Navigator,
    length: 0,
    illegal: true,
    members: [
      'maxTouchPoints',
      'scheduling',
      'userActivation',
      'geolocation',
      'ink',
      'doNotTrack',
      'mediaCapabilities',
      'permissions',
      'webkitTemporaryStorage',
      'webkitPersistentStorage',
      'windowControlsOverlay',
      'hardwareConcurrency',
      'cookieEnabled',
      'appCodeName',
      'appName',
      'appVersion',
      'platform',
      'product',
      'productSub',
      'userAgent',
      'vendor',
      'vendorSub',
      'language',
      'languages',
      'onLine',
      'webdriver',
      'plugins',
      'mimeTypes',
      'pdfViewerEnabled',
      'connection',
      'getGamepads:0',
      'javaEnabled:0',
      'sendBeacon:1',
      'vibrate:1',
      'mediaSession',
      'globalPrivacyControl',
      'constructor',
      'cpuPerformance',
      'clipboard',
      'credentials',
      'keyboard',
      'managed',
      'mediaDevices',
      'serviceWorker',
      'virtualKeyboard',
      'wakeLock',
      'deviceMemory',
      'userAgentData',
      'locks',
      'storage',
      'gpu',
      'login',
      'devicePosture',
      'hid',
      'presentation',
      'serial',
      'usb',
      'xr',
      'storageBuckets',
      'clearAppBadge:0',
      'getBattery:0',
      'getUserMedia:3',
      'requestMIDIAccess:0',
      'requestMediaKeySystemAccess:2',
      'setAppBadge:0',
      'webkitGetUserMedia:3',
      'getInstalledRelatedApps:0',
      'install:0',
      'registerProtocolHandler:2',
      'unregisterProtocolHandler:2',
      '@@toStringTag',
    ],
  });

  var navigatorObject = new Navigator(INTERNAL);
  nativeShape.defineGlobalAttribute('navigator', function () {
    return navigatorObject;
  });

  var SCREEN = {
    __proto__: null,
    width: native.screenWidth,
    height: native.screenHeight,
    availWidth: native.availWidth,
    availHeight: native.availHeight,
    availLeft: native.availLeft,
    availTop: native.availTop,
    colorDepth: native.colorDepth,
  };

  /**
   * Screen: the display's size and depth, from the client profile. An EventTarget, for
   * `change`, which never fires: the profile's display does not change.
   * @node n/a — Chrome 158, tests/web/cases/shape-navigator.expected (shape) and
   *   navigator-profile.expected (relations: availWidth <= width, …).
   * @deviates isExtended is always false; `orientation` never changes.
   */
  class Screen extends EventTargetImpl {
    #onchange = null;
    // The listener entry the handler occupies while it is non-null.
    #handler = null;

    constructor(token) {
      if (token !== INTERNAL) throw new TypeErrorP('Illegal constructor');
      super();
    }

    static {
      isScreen = function (o) {
        return typeof o === 'object' && o !== null && #handler in o;
      };
      readChangeHandler = function (target) {
        return target.#onchange;
      };
    }

    get availWidth() {
      if (!isScreen(this)) throw illegalInvocation();
      return SCREEN.availWidth;
    }

    get availHeight() {
      if (!isScreen(this)) throw illegalInvocation();
      return SCREEN.availHeight;
    }

    get width() {
      if (!isScreen(this)) throw illegalInvocation();
      return SCREEN.width;
    }

    get height() {
      if (!isScreen(this)) throw illegalInvocation();
      return SCREEN.height;
    }

    get colorDepth() {
      if (!isScreen(this)) throw illegalInvocation();
      return SCREEN.colorDepth;
    }

    get pixelDepth() {
      if (!isScreen(this)) throw illegalInvocation();
      return SCREEN.colorDepth;
    }

    get availLeft() {
      if (!isScreen(this)) throw illegalInvocation();
      return SCREEN.availLeft;
    }

    get availTop() {
      if (!isScreen(this)) throw illegalInvocation();
      return SCREEN.availTop;
    }

    get orientation() {
      if (!isScreen(this)) throw illegalInvocation();
      return APIS.orientation();
    }

    get onchange() {
      if (!isScreen(this)) throw illegalInvocation();
      return this.#onchange;
    }

    set onchange(fn) {
      if (!isScreen(this)) throw illegalInvocation();
      this.#onchange = typeof fn === 'function' ? fn : null;
      if (this.#onchange !== null && this.#handler === null) {
        this.#handler = attachHandler(this, CHANGE, readChangeHandler);
      } else if (this.#onchange === null && this.#handler !== null) {
        detachHandler(this, CHANGE, this.#handler);
        this.#handler = null;
      }
    }

    get isExtended() {
      if (!isScreen(this)) throw illegalInvocation();
      return false;
    }
  }

  nativeShape.defineInterface({
    name: 'Screen',
    impl: Screen,
    length: 0,
    illegal: true,
    parent: eventTarget.EventTarget,
    members: [
      'availWidth',
      'availHeight',
      'width',
      'height',
      'colorDepth',
      'pixelDepth',
      'availLeft',
      'availTop',
      'orientation',
      'constructor',
      'onchange',
      'isExtended',
      '@@toStringTag',
    ],
  });

  var screenObject = new Screen(INTERNAL);
  // [Replaceable], as Chrome's: `screen = x` replaces the accessor with x.
  nativeShape.defineGlobalAttribute(
    'screen',
    function () {
      return screenObject;
    },
    true,
  );

  // The window's geometry, each a [Replaceable] attribute of the window. The viewport
  // is the profile's; the scroll offsets are internal/layout's, which scrollTo and
  // scrollIntoView move over its estimated document.
  layout.setViewport(native);
  function constant(value) {
    return function () {
      return value;
    };
  }

  var screenX = constant(native.screenX);
  var screenY = constant(native.screenY);
  var WINDOW_ATTRIBUTES = [
    ['innerWidth', constant(native.innerWidth)],
    ['innerHeight', constant(native.innerHeight)],
    ['scrollX', layout.scrollX],
    ['pageXOffset', layout.scrollX],
    ['scrollY', layout.scrollY],
    ['pageYOffset', layout.scrollY],
    ['screenX', screenX],
    ['screenY', screenY],
    ['outerWidth', constant(native.outerWidth)],
    ['outerHeight', constant(native.outerHeight)],
    ['devicePixelRatio', constant(native.devicePixelRatio)],
    ['screenLeft', screenX],
    ['screenTop', screenY],
  ];
  for (var i = 0; i < WINDOW_ATTRIBUTES.length; i++) {
    nativeShape.defineGlobalAttribute(WINDOW_ATTRIBUTES[i][0], WINDOW_ATTRIBUTES[i][1], true);
  }
});
