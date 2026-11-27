// dom-script-defer.page's parser-blocking script: it runs before every deferred one.
order.push('blocking current=' + name(document.currentScript) + ' ' + document.readyState);
