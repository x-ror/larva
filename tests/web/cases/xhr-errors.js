// What XMLHttpRequest throws, as a page sees it: the error class, its name and
// Blink's message, for each method and setter in each state that refuses. No request
// here reaches the network except the ones awaited at the end.
function show(label, f) {
  try {
    const v = f();
    print(label + ': ' + (v === undefined ? 'no throw' : 'returned ' + JSON.stringify(v)));
  } catch (e) {
    print(label + ': ' + e.constructor.name + ' ' + e.name + ': ' + e.message + ' code=' + e.code);
  }
}

const x = () => new XMLHttpRequest();
const opened = (method = 'GET', async = true) => {
  const xhr = new XMLHttpRequest();
  xhr.open(method, ORIGIN + '/fx/text', async);
  return xhr;
};

show('call without new', () => XMLHttpRequest());
show('Upload construct', () => new XMLHttpRequestUpload());
show('EventTarget construct', () => new XMLHttpRequestEventTarget());
show('ProgressEvent no args', () => new ProgressEvent());
show('ProgressEvent bad init', () => new ProgressEvent('x', 5));
show('ProgressEvent NaN loaded', () => new ProgressEvent('x', { loaded: NaN }));
show('ProgressEvent Infinity total', () => new ProgressEvent('x', { total: Infinity }));
show('ProgressEvent string loaded', () => new ProgressEvent('x', { loaded: '7' }).loaded);
show('open no args', () => x().open());
show('open one arg', () => x().open('GET'));
show('open bad method', () => x().open('b d', ORIGIN));
show('open empty method', () => x().open('', ORIGIN));
show('open CONNECT', () => x().open('connect', ORIGIN));
show('open TRACE', () => x().open('TRACE', ORIGIN));
show('open TRACK', () => x().open('track', ORIGIN));
show('open bad url', () => x().open('GET', 'http://['));
show('open symbol method', () => x().open(Symbol(), ORIGIN));
show('send unsent', () => x().send());
show('setRequestHeader unsent', () => x().setRequestHeader('a', 'b'));
show('setRequestHeader one arg', () => opened().setRequestHeader('a'));
show('setRequestHeader bad name', () => opened().setRequestHeader('a b', 'v'));
show('setRequestHeader empty name', () => opened().setRequestHeader('', 'v'));
show('setRequestHeader bad value', () => opened().setRequestHeader('a', 'x\r\ny'));
show('setRequestHeader non-latin1', () => opened().setRequestHeader('a', '☕'));
show('setRequestHeader forbidden', () => opened().setRequestHeader('Host', 'x'));
show('setRequestHeader trims', () => opened().setRequestHeader('a', ' \tv \t'));
show('getResponseHeader no args', () => x().getResponseHeader());
show('getResponseHeader bad name', () => x().getResponseHeader('a b'));
show('overrideMimeType no args', () => x().overrideMimeType());
show('overrideMimeType unsent', () => x().overrideMimeType('text/plain'));
show('responseType bogus', () => {
  const xhr = x();
  xhr.responseType = 'bogus';
  return xhr.responseType;
});
show('responseType document', () => {
  const xhr = x();
  xhr.responseType = 'document';
  return xhr.responseType;
});
show('responseText of json', () => {
  const xhr = x();
  xhr.responseType = 'json';
  return xhr.responseText;
});
show('timeout coerces', () => {
  const xhr = x();
  xhr.timeout = '12.7';
  return xhr.timeout;
});
show('timeout negative', () => {
  const xhr = x();
  xhr.timeout = -1;
  return xhr.timeout;
});
show('withCredentials coerces', () => {
  const xhr = x();
  xhr.withCredentials = 'yes';
  return xhr.withCredentials;
});
show('sync open with timeout', () => {
  const xhr = x();
  xhr.timeout = 10;
  xhr.open('GET', ORIGIN + '/fx/text', false);
});
show('sync open then timeout', () => {
  opened('GET', false).timeout = 10;
});
show('sync responseType', () => {
  opened('GET', false).responseType = 'json';
});
show('sync open with responseType', () => {
  const xhr = x();
  xhr.responseType = 'text';
  xhr.open('GET', ORIGIN + '/fx/text', false);
});
show('sync open readyState', () => opened('GET', false).readyState);
show('open async undefined', () => {
  const xhr = x();
  xhr.open('GET', ORIGIN + '/fx/text', undefined);
  xhr.timeout = 5;
  return xhr.timeout;
});
show('getter on a foreign receiver', () =>
  Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'readyState').get.call({}),
);
show('handler on a foreign receiver', () =>
  Object.getOwnPropertyDescriptor(XMLHttpRequestEventTarget.prototype, 'onload').get.call({}),
);
show('upload handler', () => {
  const up = x().upload;
  up.onprogress = () => {};
  return typeof up.onprogress + ' ' + (up instanceof XMLHttpRequestEventTarget);
});

async function main() {
  // The states that need a request in flight.
  const xhr = opened();
  xhr.send();
  show('send twice', () => xhr.send());
  show('setRequestHeader after send', () => xhr.setRequestHeader('a', 'b'));
  show('withCredentials after send', () => {
    xhr.withCredentials = true;
  });
  show('timeout after send', () => {
    xhr.timeout = 600000;
    return xhr.timeout;
  });
  await new Promise((resolve) => (xhr.onload = resolve));
  show('responseType when done', () => {
    xhr.responseType = 'json';
  });
  show('overrideMimeType when done', () => xhr.overrideMimeType('text/plain'));
  show('overrideMimeType when opened', () => opened().overrideMimeType('nonsense'));

  // Methods are normalized as fetch's: the standard ones uppercased whatever their case.
  for (const m of ['get', 'pOsT', 'delete', 'options', 'Put']) {
    const r = new XMLHttpRequest();
    r.open(m, ORIGIN + '/fx/xhr-echo');
    r.send();
    await new Promise((resolve) => (r.onload = resolve));
    print('method ' + m + ' -> ' + JSON.parse(r.responseText).method);
  }
}
main().catch((e) => print('FAILED ' + e));
