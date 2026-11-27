// User Timing: performance.mark/measure, the entry buffer and its readers, and the
// PerformanceEntry/PerformanceMark/PerformanceMeasure interfaces — arguments, errors
// and entry order. Only mark and measure entries are printed: Chrome's buffer also
// holds the page's navigation, paint and resource entries, which Larva does not record.
function t(label, f) {
  try {
    print(label + ' ' + f());
  } catch (e) {
    print(label + ' THREW ' + e.constructor.name + ': ' + e.message);
  }
}
// Mark `a` takes its time from the clock, so where it sorts depends on how long the
// page took to get there: the order lines leave it out.
const names = (list) =>
  list
    .filter((e) => e.name !== 'a')
    .map((e) => e.name)
    .join(',');
const timed = (list) => list.filter((e) => e.entryType === 'mark' || e.entryType === 'measure');

print(
  'chain ' +
    Object.getPrototypeOf(Performance.prototype).constructor.name +
    ' ' +
    (performance instanceof EventTarget),
);
t('new Performance', () => new Performance());
t('new PerformanceEntry', () => new PerformanceEntry());
t('new PerformanceMeasure', () => new PerformanceMeasure());
t('new PerformanceMark()', () => new PerformanceMark());
const m0 = new PerformanceMark('x', { startTime: 5, detail: { a: 1 } });
print(
  'ctor mark ' +
    m0.name +
    ' ' +
    m0.entryType +
    ' ' +
    m0.startTime +
    ' ' +
    m0.duration +
    ' ' +
    JSON.stringify(m0.detail),
);
print('ctor not buffered ' + performance.getEntriesByName('x').length);
t('ctor negative', () => new PerformanceMark('y', { startTime: -1 }));
t('ctor detail fn', () => new PerformanceMark('y', { detail: () => 1 }));
t('mark bad options', () => performance.mark('z', 5));
t('mark no args', () => performance.mark());
t('mark timing name', () => performance.mark('navigationStart'));
t('mark NaN', () => performance.mark('s', { startTime: NaN }));

const a = performance.mark('a');
print(
  'mark ' +
    (a instanceof PerformanceMark) +
    ' ' +
    a.name +
    ' ' +
    a.entryType +
    ' ' +
    typeof a.startTime +
    ' ' +
    a.duration +
    ' ' +
    a.detail,
);
const b = performance.mark('b', { startTime: 0.25, detail: 'd' });
print('mark b ' + b.startTime + ' ' + b.detail);
const det = { q: 1 };
const c = performance.mark('c', { detail: det, startTime: '0.5' });
print(
  'detail cloned ' + (c.detail !== det) + ' stable ' + (c.detail === c.detail) + ' ' + c.startTime,
);
print('name coerced ' + performance.mark({ toString: () => 'obj' }, { startTime: 1 }).name);

const m1 = performance.measure('m1', 'b', 'c');
print(
  'measure ' +
    m1.constructor.name +
    ' ' +
    m1.entryType +
    ' ' +
    m1.startTime +
    ' ' +
    m1.duration +
    ' ' +
    m1.detail,
);
const m2 = performance.measure('m2', { start: 2, end: 7, detail: 9 });
print('m2 ' + m2.startTime + ' ' + m2.duration + ' ' + m2.detail);
const m3 = performance.measure('m3', { start: 2, duration: 3 });
print('m3 ' + m3.startTime + ' ' + m3.duration);
const m4 = performance.measure('m4', { end: 20, duration: 3 });
print('m4 ' + m4.startTime + ' ' + m4.duration);
const m5 = performance.measure('m5');
print('m5 ' + m5.startTime + ' ' + (m5.duration > 0));
print('m6 ' + performance.measure('m6', 'b').startTime);
const m7 = performance.measure('m7', undefined, 'c');
print('m7 ' + m7.startTime + ' ' + m7.duration);
print('m8 ' + performance.measure('m8', { start: 'b', end: 'c' }).duration);
print('m9 ' + performance.measure('m9', 'navigationStart', 'b').startTime);
t('unknown mark', () => performance.measure('e', 'nope'));
t('number is a mark name', () => performance.measure('e', 5));
t('a measure is no mark', () => performance.measure('e', { start: 1, end: 'm2' }));
t('start+duration+end', () => performance.measure('e', { start: 1, end: 2, duration: 3 }));
t('options and endMark', () => performance.measure('e', { start: 1 }, 'a'));
t('detail only', () => performance.measure('e', { detail: null }));
t('negative', () => performance.measure('e', { start: -1 }));
t('measure no args', () => performance.measure());

print('marks ' + names(performance.getEntriesByType('mark')));
print('measures ' + names(performance.getEntriesByType('measure')));
print('all ' + names(timed(performance.getEntries())));
print(
  'byName ' +
    performance.getEntriesByName('b').length +
    ' ' +
    performance.getEntriesByName('b', 'measure').length +
    ' ' +
    performance.getEntriesByName('m1', 'measure').length,
);
print(
  'fresh arrays ' +
    Array.isArray(performance.getEntries()) +
    ' ' +
    (performance.getEntries() !== performance.getEntries()),
);
print(
  'mark json ' +
    JSON.stringify(Object.keys(b.toJSON())) +
    ' ' +
    JSON.stringify([b.toJSON().name, b.toJSON().startTime, b.toJSON().duration]),
);
print('measure json ' + JSON.stringify([m2.toJSON().entryType, m2.toJSON().duration]));
t('getEntriesByName()', () => performance.getEntriesByName());
t('getEntriesByType()', () => performance.getEntriesByType());

t('clearMarks', () => performance.clearMarks('a'));
print('after clearMarks(a) ' + names(performance.getEntriesByType('mark')));
performance.clearMarks();
print(
  'after clearMarks() ' +
    performance.getEntriesByType('mark').length +
    ' ' +
    performance.getEntriesByType('measure').length,
);
performance.clearMeasures('m1');
print('after clearMeasures(m1) ' + performance.getEntriesByType('measure').length);
performance.clearMeasures();
print('after clearMeasures() ' + performance.getEntriesByType('measure').length);

t('foreign this', () => Performance.prototype.now.call({}));
t('foreign entry', () =>
  Object.getOwnPropertyDescriptor(PerformanceEntry.prototype, 'name').get.call({}),
);
print('tags ' + Object.prototype.toString.call(a) + ' ' + Object.prototype.toString.call(m1));
t('interactionCount', () => performance.interactionCount);
t('onresourcetimingbufferfull', () => performance.onresourcetimingbufferfull);
t('setResourceTimingBufferSize', () => performance.setResourceTimingBufferSize(5));
t('clearResourceTimings', () => performance.clearResourceTimings());
t('replaceable', () => {
  performance = 5;
  return typeof performance;
});
