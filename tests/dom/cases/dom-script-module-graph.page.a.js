// dom-script-module-graph.page: imports c, exports a live counter and a default.
import { c } from './dom-script-module-graph.page.c.js';
order.push('a evaluates c=' + c);
export let counter = 0;
export function inc() {
  counter++;
}
export default 'A' + c;
