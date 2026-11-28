// dom-script-module-graph.page: an external module script, deferred like the inline ones.
import { b } from './dom-script-module-graph.page.b.js';
order.push(
  'ext evaluates b=' + b + ' ' + document.readyState + ' meta=' + import.meta.url.split('/').pop(),
);
// A dynamic import that resolves settles after the load event in Chrome (a fetch, even
// for a module already in the map), so only the one that fails at resolution is here;
// cmd/lava/module_script_test.odin covers the rest.
import('bare-specifier').catch(function (e) {
  order.push('bare ' + e.name + ': ' + e.message);
});
