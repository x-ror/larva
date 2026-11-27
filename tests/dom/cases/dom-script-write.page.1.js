// dom-script-write.page's written external script: it writes at its own insertion point.
order.push('ext runs current=' + name(document.currentScript));
document.write('<span id="from-ext">from ext</span>');
