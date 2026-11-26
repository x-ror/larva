// Each fire of an interval is one timer nesting level deeper than the last, so a 0 ms
// interval is clamped to 4 ms from its 7th fire on: fires 7 to 12 span six 4 ms periods.
// Only a lower bound on that span is printed, with slack for Lava's whole-millisecond
// loop clock; one gap alone is no bound, since a late fire is followed by one back on
// the 4 ms grid (Chrome's virtual time showed 10.5 then 1.4). The first six fire back
// to back, which no case can bound from above on a loaded host
// (pkg/runtime/eventloop's nested_intervals_clamp_to_4ms_past_level_5 pins them on a
// virtual clock).
const times = [];
const id = setInterval(() => {
  times.push(performance.now());
  if (times.length === 12) {
    clearInterval(id);
    print('fires 7-12 took at least 20 ms: ' + (times[11] - times[5] >= 20));
  }
}, 0);
