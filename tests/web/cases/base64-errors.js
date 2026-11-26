// atob/btoa rejections with Chrome's shapes and text: an InvalidCharacterError
// DOMException (legacy code 5, no own `code`) for a character outside the
// forgiving-base64 alphabet, a misplaced or excess '=', a lone trailing character, and a
// code unit past Latin-1; a TypeError for a missing argument or a Symbol.
function show(label, f) {
  try {
    const out = f();
    print(label + ': ' + JSON.stringify(out));
  } catch (e) {
    print(
      label +
        ': ' +
        e.constructor.name +
        ' ' +
        e.name +
        ' code ' +
        e.code +
        ' own code ' +
        Object.prototype.hasOwnProperty.call(e, 'code') +
        ' ' +
        Object.prototype.toString.call(e),
    );
    print('  ' + JSON.stringify(e.message));
  }
}
show('atob !', () => atob('!'));
show('atob VT', () => atob('Zm9v\vYmFy'));
show('atob Z', () => atob('Z'));
show('atob a=', () => atob('a='));
show('atob ab=', () => atob('ab='));
show('atob =ab', () => atob('=abc'));
show('atob ab===', () => atob('ab==='));
show('atob Zm9v=', () => atob('Zm9v='));
show('atob ok', () => atob(' Zm9v YmFy\n'));
show('btoa U+0100', () => btoa('Ā'));
show('btoa ok', () => btoa('ÿ'));
show('atob()', () => atob());
show('btoa()', () => btoa());
show('atob Symbol', () => atob(Symbol('s')));
show('btoa Symbol', () => btoa(Symbol('s')));
show('atob null', () => atob(null));
show('btoa undefined', () => btoa(undefined));
