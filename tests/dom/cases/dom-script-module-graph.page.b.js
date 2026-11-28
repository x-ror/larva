// dom-script-module-graph.page: imports c too, and re-exports all of it.
import { c } from './dom-script-module-graph.page.c.js';
order.push('b evaluates c=' + c);
export const b = 'B' + c;
export * from './dom-script-module-graph.page.c.js';
