// node:dns — modeled on Node's dns / dns.promises. Tier 1 (lookup) is backed by
// the OS resolver (getaddrinfo) through the native bridge (pkg/runtime/dns.odin
// -> core:net), run off the event loop. The record-type queries (resolve*,
// reverse, lookupService) and the Resolver class are Tier 2 (c-ares) and throw a
// clear "not implemented" until that backend lands — the full surface is exposed
// so feature-detection and shapes match Node.
(function (require, module, exports, native) {
  'use strict';

  if (!native) {
    throw new Error('node:dns is unavailable: native bindings missing');
  }

  // getaddrinfo hint flags. These mirror Node's numeric values, which come from
  // the platform headers and so DIFFER by OS: Linux/glibc uses 32/8/16, while
  // Darwin and Windows use 1024/2048/256 (<netdb.h> / ws2def.h). User code does
  // bitwise math with them, so we pick the host platform's set. Lava's resolver is
  // the core:net DNS client rather than a real getaddrinfo, so ADDRCONFIG/V4MAPPED
  // have no behavioral effect yet — but they are still validated like Node so
  // invalid hint masks throw rather than silently passing.
  var _bsdLikeFlags = process.platform === 'darwin' || process.platform === 'win32';
  var ADDRCONFIG = _bsdLikeFlags ? 1024 : 32;
  var V4MAPPED = _bsdLikeFlags ? 2048 : 8;
  var ALL = _bsdLikeFlags ? 256 : 16;

  // ---- Node-parity argument validation -------------------------------------
  // dns.lookup is strict about option types/values: Node throws synchronously on
  // bad input (ERR_INVALID_ARG_TYPE / ERR_INVALID_ARG_VALUE, both TypeError) so
  // mistakes surface instead of resolving as "any family". We mirror the codes and
  // shapes; message text is close but the contract callers rely on is code + type.
  function typeErr(code, message) {
    var e = new TypeError(message);
    e.code = code;
    return e;
  }
  function show(value) {
    return typeof value === 'string' ? "'" + value + "'" : String(value);
  }
  function propWord(name) {
    return name.indexOf('.') !== -1 ? 'property' : 'argument';
  }
  function invalidArgType(name, expected, value) {
    var kind = value === null ? 'null' : typeof value;
    return typeErr(
      'ERR_INVALID_ARG_TYPE',
      'The "' +
        name +
        '" ' +
        propWord(name) +
        ' must be ' +
        expected +
        '. Received type ' +
        kind +
        ' (' +
        show(value) +
        ')',
    );
  }
  function invalidArgValue(name, value, reason) {
    return typeErr(
      'ERR_INVALID_ARG_VALUE',
      'The ' +
        propWord(name) +
        " '" +
        name +
        "' " +
        (reason || 'is invalid') +
        '. Received ' +
        show(value),
    );
  }
  function validateBoolean(value, name) {
    if (typeof value !== 'boolean') throw invalidArgType(name, 'of type boolean', value);
  }
  function validateNumber(value, name) {
    if (typeof value !== 'number') throw invalidArgType(name, 'of type number', value);
  }
  function validateOneOf(value, name, list) {
    if (list.indexOf(value) === -1) {
      var allowed = list.map(show).join(', ');
      throw invalidArgValue(name, value, 'must be one of: ' + allowed);
    }
  }
  // Node accepts the 'IPv4'/'IPv6' aliases, then requires the family to be 0/4/6;
  // anything else (including the string '4') is ERR_INVALID_ARG_VALUE.
  function parseFamily(f, name) {
    if (f === 'IPv4') return 4;
    if (f === 'IPv6') return 6;
    validateOneOf(f, name, [0, 4, 6]);
    return f;
  }
  // A hint mask is valid iff it only sets known flags (matches Node's validateHints).
  function validateHints(hints) {
    if ((hints & ~(ADDRCONFIG | V4MAPPED | ALL)) !== 0) {
      throw invalidArgValue('hints', hints);
    }
  }
  // Result-order names map to the small integer codes the native bridge understands.
  var ORDER_CODES = { verbatim: 0, ipv4first: 1, ipv6first: 2 };

  function makeDnsError(code, syscall, hostname) {
    var err = new Error(syscall + ' ' + code + (hostname ? ' ' + hostname : ''));
    err.code = code;
    err.errno = code;
    err.syscall = syscall;
    if (hostname !== undefined) err.hostname = hostname;
    return err;
  }

  function validateHostname(name) {
    // Node accepts a falsy hostname (resolves to null); only a non-string truthy
    // value is a type error.
    if (name && typeof name !== 'string') {
      var e = new TypeError(
        'The "hostname" argument must be of type string. Received ' + typeof name,
      );
      e.code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }
  }

  // dns.lookup(hostname[, options], callback)
  function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== 'function') {
      throw invalidArgType('callback', 'of type function', callback);
    }
    validateHostname(hostname);

    var family = 0;
    var all = false;
    var order = defaultResultOrder;
    if (typeof options === 'number') {
      // Numeric options is the family shorthand: dns.lookup(host, 4, cb).
      validateOneOf(options, 'family', [0, 4, 6]);
      family = options;
    } else if (options !== undefined && options !== null && typeof options !== 'object') {
      throw invalidArgType('options', 'of type object or integer', options);
    } else if (options) {
      if (options.hints !== undefined && options.hints !== null) {
        validateNumber(options.hints, 'options.hints');
        validateHints(options.hints >>> 0);
      }
      if (options.family !== undefined && options.family !== null) {
        family = parseFamily(options.family, 'options.family');
      }
      if (options.all !== undefined && options.all !== null) {
        validateBoolean(options.all, 'options.all');
        all = options.all;
      }
      if (options.verbatim !== undefined && options.verbatim !== null) {
        validateBoolean(options.verbatim, 'options.verbatim');
        order = options.verbatim ? 'verbatim' : 'ipv4first';
      }
      if (options.order !== undefined && options.order !== null) {
        validateOneOf(options.order, 'options.order', ['verbatim', 'ipv4first', 'ipv6first']);
        order = options.order;
      }
    }

    // Node returns null/[] for a falsy hostname rather than erroring.
    if (!hostname) {
      queueMicrotask(function () {
        if (all) callback(null, []);
        else callback(null, null, family === 6 ? 6 : 4);
      });
      return;
    }

    native.lookup(String(hostname), family, ORDER_CODES[order], all, function (code, addresses) {
      if (code) {
        callback(makeDnsError(code, 'getaddrinfo', hostname));
        return;
      }
      if (all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    });
  }

  var defaultResultOrder = 'verbatim';
  function setDefaultResultOrder(order) {
    if (order !== 'ipv4first' && order !== 'ipv6first' && order !== 'verbatim') {
      var e = new TypeError(
        "The argument 'order' must be one of 'verbatim', 'ipv4first', 'ipv6first'. Received '" +
          order +
          "'",
      );
      e.code = 'ERR_INVALID_ARG_VALUE';
      throw e;
    }
    defaultResultOrder = order;
  }
  function getDefaultResultOrder() {
    return defaultResultOrder;
  }

  // ---- Tier 2 (c-ares) — surface present, not yet implemented ----
  var TIER2 = [
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCname',
    'resolveCaa',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTxt',
    'reverse',
    'lookupService',
    'getServers',
    'setServers',
  ];

  function notImplemented(name) {
    return function () {
      throw new Error('node:dns ' + name + ' is not implemented in Lava (pending c-ares backend)');
    };
  }

  function Resolver(options) {
    if (!(this instanceof Resolver)) return new Resolver(options);
  }
  TIER2.forEach(function (m) {
    Resolver.prototype[m] = notImplemented('Resolver.' + m);
  });
  Resolver.prototype.cancel = notImplemented('Resolver.cancel');
  Resolver.prototype.setLocalAddress = notImplemented('Resolver.setLocalAddress');

  // ---- promises ----
  function promisesLookup(hostname, options) {
    var all = !!(options && typeof options === 'object' && options.all);
    return new Promise(function (resolve, reject) {
      lookup(hostname, options, function (err, address, family) {
        if (err) {
          reject(err);
        } else if (all) {
          resolve(address); // `address` is the array when all=true
        } else {
          resolve({ address: address, family: family });
        }
      });
    });
  }

  function PromisesResolver(options) {
    if (!(this instanceof PromisesResolver)) return new PromisesResolver(options);
  }
  TIER2.forEach(function (m) {
    PromisesResolver.prototype[m] = notImplemented('promises.Resolver.' + m);
  });
  PromisesResolver.prototype.cancel = notImplemented('promises.Resolver.cancel');

  var promises = {
    lookup: promisesLookup,
    Resolver: PromisesResolver,
    setDefaultResultOrder: setDefaultResultOrder,
    getDefaultResultOrder: getDefaultResultOrder,
  };
  TIER2.forEach(function (m) {
    promises[m] = notImplemented('promises.' + m);
  });

  // ---- error codes & getaddrinfo hint flags (Node parity) ----
  var CODES = {
    NODATA: 'ENODATA',
    FORMERR: 'EFORMERR',
    SERVFAIL: 'ESERVFAIL',
    NOTFOUND: 'ENOTFOUND',
    NOTIMP: 'ENOTIMP',
    REFUSED: 'EREFUSED',
    BADQUERY: 'EBADQUERY',
    BADNAME: 'EBADNAME',
    BADFAMILY: 'EBADFAMILY',
    BADRESP: 'EBADRESP',
    CONNREFUSED: 'ECONNREFUSED',
    TIMEOUT: 'ETIMEOUT',
    EOF: 'EOF',
    FILE: 'EFILE',
    NOMEM: 'ENOMEM',
    DESTRUCTION: 'EDESTRUCTION',
    BADSTR: 'EBADSTR',
    BADFLAGS: 'EBADFLAGS',
    NONAME: 'ENONAME',
    BADHINTS: 'EBADHINTS',
    NOTINITIALIZED: 'ENOTINITIALIZED',
    LOADIPHLPAPI: 'ELOADIPHLPAPI',
    ADDRGETNETWORKPARAMS: 'EADDRGETNETWORKPARAMS',
    CANCELLED: 'ECANCELLED',
  };

  exports.lookup = lookup;
  exports.setDefaultResultOrder = setDefaultResultOrder;
  exports.getDefaultResultOrder = getDefaultResultOrder;
  exports.Resolver = Resolver;
  exports.ADDRCONFIG = ADDRCONFIG;
  exports.V4MAPPED = V4MAPPED;
  exports.ALL = ALL;
  Object.keys(CODES).forEach(function (k) {
    exports[k] = CODES[k];
  });
  TIER2.forEach(function (m) {
    exports[m] = notImplemented(m);
  });
  exports.promises = promises;
});
