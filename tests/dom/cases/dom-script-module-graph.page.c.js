// dom-script-module-graph.page: the shared leaf, which must evaluate once.
window.cEvaluations = (window.cEvaluations || 0) + 1;
order.push('c evaluates');
export const c = 'C';
export { c as other };
export const {
  p,
  q: [r],
} = { p: 'P', q: ['R'] };
