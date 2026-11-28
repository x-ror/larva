// web-oracle: real-time 3000
// What navigator's member objects and operations answer (#8): userAgentData,
// plugins/mimeTypes, connection, permissions.query, locks, storage, the device APIs a
// headless host has nothing behind, and screen.orientation. Values that are the
// machine's in a recording (rtt, quota, the brand list) print as types and relations;
// permission states are a fresh profile's, the same on every host. Real time: Chrome
// answers permissions.query over IPC, which virtual time does not wait for.
const n = navigator;
const tag = (v) => Object.prototype.toString.call(v);
const show = (label, p) =>
  (p instanceof Promise ? p : Promise.resolve('not a promise: ' + tag(p))).then(
    (v) => print(label + ' ok ' + tag(v) + ' ' + JSON.stringify(v)),
    (e) => print(label + ' rej ' + e.name + ': ' + e.message),
  );
const sync = (label, f) => {
  try {
    const v = f();
    print(label + ' ret ' + tag(v) + ' ' + JSON.stringify(v));
  } catch (e) {
    print(label + ' threw ' + e.name + ': ' + e.message);
  }
};

(async () => {
  // userAgentData: the low-entropy values and how they relate to the UA string.
  const u = n.userAgentData;
  const major = /Chrome\/(\d+)\./.exec(n.userAgent)[1];
  const brands = u.brands;
  print(
    'uad ' +
      tag(u) +
      ' same ' +
      (u === n.userAgentData) +
      ' brands same ' +
      (u.brands === u.brands),
  );
  print(
    'brands ' +
      Array.isArray(brands) +
      ' frozen ' +
      Object.isFrozen(brands) +
      ' item frozen ' +
      Object.isFrozen(brands[0]) +
      ' keys ' +
      brands.every((b) => Object.keys(b).join() === 'brand,version' && /^\d+$/.test(b.version)),
  );
  print('chromium ' + brands.some((b) => b.brand === 'Chromium' && b.version === major));
  print('grease ' + brands.some((b) => /Brand/.test(b.brand)));
  print(
    'mobile ' +
      u.mobile +
      ' platform ' +
      u.platform +
      ' in platform ' +
      n.platform.startsWith(u.platform),
  );
  print(
    'toJSON ' +
      JSON.stringify(Object.keys(u.toJSON())) +
      ' ' +
      (JSON.stringify(u) === JSON.stringify(u.toJSON())),
  );
  const hev = await u.getHighEntropyValues([
    'wow64',
    'architecture',
    'bitness',
    'fullVersionList',
    'model',
    'platformVersion',
    'uaFullVersion',
    'formFactors',
    'bogus',
  ]);
  print('hev keys ' + Object.keys(hev).join());
  print(
    'hev types ' +
      [hev.architecture, hev.bitness, hev.model, hev.platformVersion, hev.uaFullVersion]
        .map((v) => typeof v)
        .join() +
      ' ' +
      typeof hev.wow64 +
      ' ' +
      Array.isArray(hev.formFactors),
  );
  print('full version ' + hev.uaFullVersion.startsWith(major + '.'));
  print(
    'fullVersionList ' +
      (hev.fullVersionList.length === brands.length) +
      ' ' +
      hev.fullVersionList.every(
        (b, i) => b.brand === brands[i].brand && b.version.startsWith(brands[i].version + '.'),
      ),
  );
  print('hev low ' + JSON.stringify(Object.keys(await u.getHighEntropyValues([]))));
  await show('hev none', u.getHighEntropyValues());
  await show('hev string', u.getHighEntropyValues('x'));

  // plugins and mimeTypes: Chrome's five PDF viewer entries.
  const pl = n.plugins;
  print(
    'pdfViewerEnabled ' +
      n.pdfViewerEnabled +
      ' plugins ' +
      tag(pl) +
      ' ' +
      pl.length +
      ' same ' +
      (pl === n.plugins),
  );
  for (let i = 0; i < pl.length; i++) {
    const p = pl[i];
    print(
      ' plugin ' +
        JSON.stringify([p.name, p.filename, p.description, p.length]) +
        ' ' +
        Object.getOwnPropertyNames(p),
    );
    for (let j = 0; j < p.length; j++) {
      print(
        '   mime ' +
          JSON.stringify([p[j].type, p[j].suffixes, p[j].description]) +
          ' ' +
          (p[j].enabledPlugin === p) +
          ' ' +
          (p[j] === n.mimeTypes[j]),
      );
    }
  }
  print('plugin names ' + Object.getOwnPropertyNames(pl).join('|'));
  print('plugin keys ' + Object.keys(pl).join());
  print(
    'plugin descs ' +
      JSON.stringify(Object.getOwnPropertyDescriptor(pl, '0'), (k, v) =>
        k === 'value' ? tag(v) : v,
      ) +
      ' ' +
      JSON.stringify(Object.getOwnPropertyDescriptor(pl, 'PDF Viewer'), (k, v) =>
        k === 'value' ? tag(v) : v,
      ),
  );
  print(
    'plugin item ' +
      (pl.item(1) === pl[1]) +
      ' ' +
      (pl.item('1') === pl[1]) +
      ' ' +
      (pl.item(4294967296) === pl[0]) +
      ' ' +
      pl.item(-1) +
      ' ' +
      pl.item(9),
  );
  print(
    'plugin namedItem ' +
      (pl.namedItem('Chrome PDF Viewer') === pl[1]) +
      ' ' +
      pl.namedItem('x') +
      ' ' +
      (pl['PDF Viewer'] === pl[0]),
  );
  print(
    'plugin iterator ' +
      (pl[Symbol.iterator] === Array.prototype.values) +
      ' ' +
      [...pl].map((p) => p.name).join('|'),
  );
  sync('plugins item()', () => pl.item());
  sync('plugin namedItem()', () => pl[0].namedItem());
  sync('refresh', () => pl.refresh());
  const mt = n.mimeTypes;
  print('mimeTypes ' + tag(mt) + ' ' + mt.length + ' ' + Object.getOwnPropertyNames(mt).join('|'));
  for (let i = 0; i < mt.length; i++) {
    print(
      ' mime ' +
        JSON.stringify([mt[i].type, mt[i].suffixes, mt[i].description]) +
        ' ' +
        (mt[i].enabledPlugin === pl[0]),
    );
  }
  print(
    'mime named ' + (mt['application/pdf'] === mt[0]) + ' ' + (mt.namedItem('text/pdf') === mt[1]),
  );
  print(
    'for-in plugins ' +
      Object.entries(Object.getOwnPropertyDescriptors(pl)).filter(([, d]) => d.enumerable).length,
  );

  // connection: the values are the network's, so types and Chrome's rounding.
  const c = n.connection;
  print(
    'connection ' +
      tag(c) +
      ' same ' +
      (c === n.connection) +
      ' EventTarget ' +
      (c instanceof EventTarget),
  );
  print('effectiveType ' + ['slow-2g', '2g', '3g', '4g'].includes(c.effectiveType));
  print(
    'rtt ' +
      (Number.isInteger(c.rtt) && c.rtt % 25 === 0) +
      ' downlink ' +
      (typeof c.downlink === 'number' && c.downlink <= 10),
  );
  print(
    'saveData ' +
      c.saveData +
      ' onchange ' +
      c.onchange +
      ' type ' +
      c.type +
      ' downlinkMax ' +
      c.downlinkMax,
  );
  c.onchange = () => {};
  print('onchange set ' + typeof c.onchange);
  c.onchange = 'x';
  print('onchange string ' + c.onchange);

  // permissions.query: a fresh profile's states.
  for (const name of [
    'notifications',
    'geolocation',
    'camera',
    'microphone',
    'midi',
    'clipboard-read',
    'clipboard-write',
    'persistent-storage',
    'background-sync',
    'storage-access',
    'accelerometer',
    'periodic-background-sync',
    'screen-wake-lock',
  ]) {
    await show(
      'perm ' + name,
      n.permissions.query({ name }).then((s) => s.state),
    );
  }

  await show('perm push', n.permissions.query({ name: 'push' }));
  await show(
    'perm push visible',
    n.permissions.query({ name: 'push', userVisibleOnly: true }).then((s) => s.state),
  );
  await show('perm nfc', n.permissions.query({ name: 'nfc' }));
  await show('perm bogus', n.permissions.query({ name: 'bogus' }));
  await show('perm {}', n.permissions.query({}));
  await show('perm ()', n.permissions.query());
  await show('perm 5', n.permissions.query(5));
  await show('perm fullscreen', n.permissions.query({ name: 'fullscreen' }));
  const s1 = await n.permissions.query({ name: 'notifications' });
  print(
    'status ' +
      tag(s1) +
      ' ' +
      s1.name +
      ' ' +
      s1.state +
      ' onchange ' +
      s1.onchange +
      ' new ' +
      (s1 !== (await n.permissions.query({ name: 'notifications' }))) +
      ' EventTarget ' +
      (s1 instanceof EventTarget),
  );

  // Web Locks: a held lock queues the next request; ifAvailable gets null.
  await show(
    'lock',
    n.locks.request('a', (l) => [tag(l), l.name, l.mode, JSON.stringify(Object.keys(l))].join(' ')),
  );
  await show(
    'lock shared',
    n.locks.request('a', { mode: 'shared' }, (l) => l.mode),
  );
  await show(
    'lock dash',
    n.locks.request('-a', () => 1),
  );
  await show('lock no callback', n.locks.request('a'));
  await show('lock bad callback', n.locks.request('a', 5));
  await show(
    'lock bad mode',
    n.locks.request('a', { mode: 'x' }, () => 1),
  );
  await show(
    'lock ifAvailable free',
    n.locks.request('a', { ifAvailable: true }, (l) => l === null),
  );
  {
    const order = [];
    let release;
    let started;
    const running = new Promise((r) => (started = r));
    const p1 = n.locks.request('q', () => {
      order.push('1');
      started();
      return new Promise((r) => (release = r));
    });
    const p2 = n.locks.request('q', { ifAvailable: true }, (l) => {
      order.push('2 ' + l);
    });
    const p3 = n.locks.request('q', (l) => {
      order.push('3 ' + l.name);
      return 'three';
    });
    await running;
    await p2;
    const snap = await n.locks.query();
    print(
      'locks held ' +
        JSON.stringify(snap.held.map((x) => [x.name, x.mode, typeof x.clientId, Object.keys(x)])) +
        ' pending ' +
        JSON.stringify(snap.pending.map((x) => [x.name, x.mode])),
    );
    release('one');
    print(
      'locks results ' + JSON.stringify(await Promise.all([p1, p2, p3])) + ' ' + order.join(','),
    );
  }
  {
    const order = [];
    let release;
    let started;
    const running = new Promise((r) => (started = r));
    const ex = n.locks.request('s', () => {
      started();
      return new Promise((r) => (release = r));
    });
    const sh1 = n.locks.request('s', { mode: 'shared' }, () => order.push('sh1'));
    const sh2 = n.locks.request('s', { mode: 'shared' }, () => order.push('sh2'));
    await running;
    print('shared waiting ' + order.length);
    release();
    await Promise.all([ex, sh1, sh2]);
    print('shared order ' + order.join(','));
  }
  await show(
    'lock thrower',
    n.locks.request('t', () => {
      throw new RangeError('boom');
    }),
  );
  print('locks empty ' + JSON.stringify(await n.locks.query()));

  // storage: the shape of the estimate; the quota is the disk's.
  await show(
    'estimate',
    n.storage
      .estimate()
      .then((e) => [Object.keys(e), typeof e.quota, e.quota > 0, JSON.stringify(e.usageDetails)]),
  );
  await show('persisted', n.storage.persisted());
  await show('persist', n.storage.persist());
  await new Promise((r) =>
    n.webkitTemporaryStorage.queryUsageAndQuota((usage, quota) => {
      print('legacy quota ' + typeof usage + ' ' + typeof quota);
      r();
    }),
  );
  print(
    'legacy quota same ' +
      (n.webkitTemporaryStorage === n.webkitPersistentStorage) +
      ' ' +
      tag(n.webkitTemporaryStorage) +
      ' ' +
      typeof globalThis.DeprecatedStorageQuota +
      ' ' +
      Object.getOwnPropertyNames(Object.getPrototypeOf(n.webkitTemporaryStorage)).join(),
  );

  // The device APIs, on a host with no devices and no user gesture.
  await show('enumerateDevices', n.mediaDevices.enumerateDevices());
  sync('supported constraints', () => Object.keys(n.mediaDevices.getSupportedConstraints()).length);
  await show('getUserMedia audio', n.mediaDevices.getUserMedia({ audio: true }));
  await show('getUserMedia none', n.mediaDevices.getUserMedia());
  sync('legacy getUserMedia none', () => n.getUserMedia());
  await new Promise((r) =>
    n.webkitGetUserMedia(
      { video: true },
      () => {},
      (e) => {
        print('legacy getUserMedia error ' + e.name + ': ' + e.message);
        r();
      },
    ),
  );
  await show('hid devices', n.hid.getDevices());
  await show('usb devices', n.usb.getDevices());
  await show('serial ports', n.serial.getPorts());
  await show('hid request', n.hid.requestDevice({ filters: [] }));
  await show('usb request', n.usb.requestDevice({ filters: [] }));
  await show('serial request', n.serial.requestPort());
  await show('xr inline', n.xr.isSessionSupported('inline'));
  await show('xr vr', n.xr.isSessionSupported('immersive-vr'));
  await show('xr bad', n.xr.isSessionSupported('x'));
  await show('xr session', n.xr.requestSession('immersive-vr'));
  await show('gpu adapter', n.gpu.requestAdapter());
  sync('gpu format', () => n.gpu.getPreferredCanvasFormat());
  const f = n.gpu.wgslLanguageFeatures;
  print(
    'wgsl ' +
      tag(f) +
      ' ' +
      (f.size > 0) +
      ' same ' +
      (f === n.gpu.wgslLanguageFeatures) +
      ' has ' +
      f.has('pointer_composite_access') +
      ' ' +
      f.has('x') +
      ' entries ' +
      [...f.entries()].every(([a, b]) => a === b) +
      ' keys ' +
      (f.keys !== f.values) +
      ' iterator ' +
      (f[Symbol.iterator] === f.values),
  );
  await show('clipboard readText', n.clipboard.readText());
  await show('clipboard writeText', n.clipboard.writeText('x'));
  await show('credentials password', n.credentials.get({ password: true }));
  await show('credentials create', n.credentials.create());
  await show('credentials store', n.credentials.store());
  await show('managed', n.managed.getManagedConfiguration([]));
  await show('midi', n.requestMIDIAccess());
  await show('mksa empty', n.requestMediaKeySystemAccess('', [{}]));
  await show('mksa no config', n.requestMediaKeySystemAccess('org.w3.clearkey', []));
  await show('mksa one arg', n.requestMediaKeySystemAccess('org.w3.clearkey'));
  await show('install', n.install());
  await show('related apps', n.getInstalledRelatedApps());
  await show('set badge', n.setAppBadge());
  await show('clear badge', n.clearAppBadge());
  await show('sw registrations', n.serviceWorker.getRegistrations());
  await show('sw registration', n.serviceWorker.getRegistration());
  await show('sw register none', n.serviceWorker.register());
  print(
    'sw controller ' +
      n.serviceWorker.controller +
      ' ready same ' +
      (n.serviceWorker.ready === n.serviceWorker.ready),
  );
  await show('login', n.login.setStatus('logged-in'));
  await show('login bad', n.login.setStatus('x'));
  await show('keyboard lock', n.keyboard.lock());
  await show('media session camera', n.mediaSession.setCameraActive(true));
  await show('decodingInfo none', n.mediaCapabilities.decodingInfo());
  await show('encodingInfo record', n.mediaCapabilities.encodingInfo({ type: 'record' }));
  await show('bucket keys', n.storageBuckets.keys());
  await show('bucket delete', n.storageBuckets.delete('x'));
  await show('bucket open none', n.storageBuckets.open());
  await show('wakeLock bad', n.wakeLock.request('x'));

  // The plain values and operations.
  print(
    'globalPrivacyControl ' +
      n.globalPrivacyControl +
      ' cpuPerformance ' +
      Number.isInteger(n.cpuPerformance),
  );
  print(
    'posture ' +
      n.devicePosture.type +
      ' overlay ' +
      n.windowControlsOverlay.visible +
      ' virtualKeyboard ' +
      n.virtualKeyboard.overlaysContent,
  );
  print(
    'userActivation ' +
      n.userActivation.isActive +
      ' ' +
      n.userActivation.hasBeenActive +
      ' isInputPending ' +
      n.scheduling.isInputPending(),
  );
  print(
    'mediaSession ' +
      n.mediaSession.metadata +
      ' ' +
      n.mediaSession.playbackState +
      ' presentation ' +
      n.presentation.defaultRequest +
      ' ' +
      n.presentation.receiver,
  );
  sync('metadata object', () => (n.mediaSession.metadata = {}));
  sync('playbackState bad', () => {
    n.mediaSession.playbackState = 'x';
    return n.mediaSession.playbackState;
  });
  sync('playbackState paused', () => {
    n.mediaSession.playbackState = 'paused';
    return n.mediaSession.playbackState;
  });
  sync('setActionHandler bad', () => n.mediaSession.setActionHandler('x', null));
  sync('setActionHandler', () => n.mediaSession.setActionHandler('play', null));
  sync('overlaysContent', () => {
    n.virtualKeyboard.overlaysContent = 1;
    return n.virtualKeyboard.overlaysContent;
  });
  sync('getCurrentPosition bad', () => n.geolocation.getCurrentPosition(5));
  sync('watchPosition', () => [
    n.geolocation.watchPosition(() => {}),
    n.geolocation.watchPosition(() => {}),
  ]);
  sync('clearWatch none', () => n.geolocation.clearWatch());
  const pads = n.getGamepads();
  print(
    'gamepads ' +
      tag(pads) +
      ' ' +
      pads.length +
      ' ' +
      pads.every((p) => p === null) +
      ' new ' +
      (pads !== n.getGamepads()),
  );
  print('vibrate ' + n.vibrate(100) + ' javaEnabled ' + n.javaEnabled());
  sync('vibrate none', () => n.vibrate());
  sync('sendBeacon none', () => n.sendBeacon());
  sync('sendBeacon ftp', () => n.sendBeacon('ftp://x/'));
  sync('sendBeacon bad', () => n.sendBeacon('http://[x'));
  sync('sendBeacon big', () => n.sendBeacon('/beacon', 'x'.repeat(70000)));
  sync('registerProtocolHandler bad', () => n.registerProtocolHandler('foo', '/x?%s'));
  sync('registerProtocolHandler one', () => n.registerProtocolHandler('web+x'));
  sync('unregisterProtocolHandler', () => n.unregisterProtocolHandler('web+x', '/x?%s'));
  const battery = n.getBattery();
  print('battery same ' + (battery === n.getBattery()));
  const b = await battery;
  print(
    'battery ' +
      tag(b) +
      ' ' +
      (b instanceof EventTarget) +
      ' ' +
      JSON.stringify([b.charging, b.chargingTime, b.dischargingTime, b.level].map(String)),
  );

  // screen.orientation.
  const o = screen.orientation;
  print(
    'orientation ' +
      tag(o) +
      ' ' +
      o.type +
      ' ' +
      o.angle +
      ' same ' +
      (o === screen.orientation) +
      ' EventTarget ' +
      (o instanceof EventTarget) +
      ' onchange ' +
      o.onchange,
  );
  print('landscape ' + (o.type.startsWith('landscape') === screen.width >= screen.height));
  await show('lock portrait', o.lock('portrait'));
  await show('lock bad', o.lock('x'));
  await show('lock none', o.lock());
  sync('unlock', () => o.unlock());

  // Brand checks.
  sync('getter on wrong receiver', () =>
    Object.getOwnPropertyDescriptor(NetworkInformation.prototype, 'rtt').get.call(n.permissions),
  );
  await show(
    'query on wrong receiver',
    Permissions.prototype.query.call(n.connection, { name: 'notifications' }),
  );
  await show('navigator op on wrong receiver', Navigator.prototype.getBattery.call({}));
  sync('navigator sync op on wrong receiver', () => Navigator.prototype.vibrate.call({}, 1));
  await show('lock on wrong receiver', ScreenOrientation.prototype.lock.call(screen, 'any'));
  sync('new Permissions', () => new Permissions());
  print('done');
})();
