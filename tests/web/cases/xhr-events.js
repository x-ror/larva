// XMLHttpRequest's ends other than a load — abort() at each stage, a network error,
// a timeout — the upload object's events, the handler attributes, and ProgressEvent
// itself. Network cases run against the fixture server (ORIGIN); /fx/slow answers
// after 3 s, so anything that ends before that ended on the client's side.
// web-oracle: real-time 2000

function track(xhr, label) {
  const log = [];
  const note = (who) => (e) =>
    log.push(
      who +
        e.type +
        '@' +
        xhr.readyState +
        (e instanceof ProgressEvent
          ? '(' + e.lengthComputable + ',' + e.loaded + ',' + e.total + ')'
          : ''),
    );
  for (const t of [
    'readystatechange',
    'loadstart',
    'progress',
    'abort',
    'error',
    'load',
    'timeout',
  ]) {
    xhr.addEventListener(t, note(''));
  }
  for (const t of ['loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend']) {
    xhr.upload.addEventListener(t, note('upload.'));
  }
  return new Promise((resolve) => {
    xhr.addEventListener('loadend', (e) => {
      note('')(e);
      Promise.resolve().then(() => {
        print(label + ' ' + log.join(' '));
        print(
          label +
            ' after ' +
            xhr.readyState +
            ' ' +
            xhr.status +
            ' ' +
            JSON.stringify(xhr.statusText) +
            ' ' +
            JSON.stringify(xhr.responseText) +
            ' headers ' +
            (xhr.getAllResponseHeaders() !== ''),
        );
        resolve(xhr);
      });
    });
  });
}

async function main() {
  // ProgressEvent on its own.
  const pe = new ProgressEvent('progress', { lengthComputable: 1, loaded: 5.9, total: -1 });
  print(
    'ProgressEvent ' +
      [pe.type, pe.lengthComputable, pe.loaded, pe.total, pe.bubbles, pe.isTrusted].join(' '),
  );
  const plain = new ProgressEvent('x');
  print('ProgressEvent defaults ' + [plain.lengthComputable, plain.loaded, plain.total].join(' '));
  const order = [];
  new ProgressEvent('x', {
    get total() {
      order.push('total');
      return 1;
    },
    get loaded() {
      order.push('loaded');
      return 1;
    },
    get lengthComputable() {
      order.push('lengthComputable');
      return 1;
    },
    get bubbles() {
      order.push('bubbles');
      return 1;
    },
  });
  print('ProgressEventInit order ' + order.join(','));

  // abort() before send: nothing fires but the state change.
  const early = new XMLHttpRequest();
  early.onreadystatechange = () => print('early readystatechange ' + early.readyState);
  early.open('GET', ORIGIN + '/fx/text');
  early.abort();
  print('early after abort ' + early.readyState);

  // abort() in flight.
  let xhr = new XMLHttpRequest();
  let done = track(xhr, 'abort in flight');
  xhr.open('GET', ORIGIN + '/fx/slow');
  xhr.send();
  print('sent ' + xhr.readyState);
  xhr.abort();
  print('aborted ' + xhr.readyState);
  await done;

  // abort() once the headers are in.
  xhr = new XMLHttpRequest();
  done = track(xhr, 'abort at headers');
  xhr.addEventListener('readystatechange', () => {
    if (xhr.readyState === 2) xhr.abort();
  });
  xhr.open('GET', ORIGIN + '/fx/text');
  xhr.send();
  await done;

  // abort() after the load: nothing fires, the state goes back to UNSENT.
  xhr = new XMLHttpRequest();
  done = track(xhr, 'load');
  xhr.open('GET', ORIGIN + '/fx/text');
  xhr.send();
  await done;
  xhr.abort();
  print(
    'abort after load ' +
      xhr.readyState +
      ' ' +
      xhr.status +
      ' ' +
      JSON.stringify(xhr.responseText),
  );

  // A network error: nothing listens on port 1.
  xhr = new XMLHttpRequest();
  done = track(xhr, 'network error');
  xhr.open('GET', 'http://127.0.0.1:1/');
  xhr.send();
  await done;

  // A timeout.
  xhr = new XMLHttpRequest();
  done = track(xhr, 'timeout');
  xhr.open('GET', ORIGIN + '/fx/slow');
  xhr.timeout = 200;
  xhr.send();
  await done;

  // Upload events with a body.
  xhr = new XMLHttpRequest();
  done = track(xhr, 'upload');
  xhr.open('POST', ORIGIN + '/fx/echo');
  xhr.send('12345');
  await done;

  // Handlers: on* attributes, their order among listeners, `this` and the event.
  xhr = new XMLHttpRequest();
  const seen = [];
  xhr.addEventListener('load', () => seen.push('listener 1'));
  xhr.onload = function (e) {
    seen.push(
      'onload this=' +
        (this === xhr) +
        ' target=' +
        (e.target === xhr) +
        ' trusted=' +
        e.isTrusted +
        ' ' +
        Object.prototype.toString.call(e) +
        ' bubbles=' +
        e.bubbles +
        ' cancelable=' +
        e.cancelable,
    );
  };
  xhr.addEventListener('load', () => seen.push('listener 2'));
  xhr.onload = xhr.onload;
  xhr.onerror = 'not a function';
  seen.push('onerror ' + xhr.onerror);
  done = new Promise((resolve) => (xhr.onloadend = resolve));
  xhr.open('GET', ORIGIN + '/fx/text');
  xhr.send();
  await done;
  print('handlers ' + seen.join(' | '));
}
main().catch((e) => print('FAILED ' + e));
