package main

import "core:strings"
import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Pins what no Chrome recording can show about internal/layout and internal/observers
// (#14): the observers' deliveries and the viewport's scroll events. Chrome delivers
// them in a rendering step after the recorder reads the page at `load`; Larva's loop
// runs them before `load` (it idles first), so a page case cannot see either side.
// IntersectionObserver's first observation reporting every target intersecting is
// itself a deviation (internal/observers' file comment) — the one lazy loaders need.

// An infinite feed driven the way lazy loaders and crawlers drive one: an
// IntersectionObserver on a sentinel below the list loads a page whenever the sentinel
// intersects, and a scroll-to-bottom loop runs until scrollHeight stops growing. The
// sentinel's first observation intersects although it is below the fold (page 2 loads
// unscrolled); the page that loaded pushes it out (an entry reports it leaving); each
// scroll to the bottom brings it back. A ResizeObserver reports the list once, with its
// estimated size; the viewport's `scroll` events reach the window.
@(test)
window_layout_observers_drive_an_infinite_feed :: proc(t: ^testing.T) {
	MARKUP :: `<!doctype html><body><div id=list></div><div id=sentinel>more</div><script>
var pages = 0, seen = [], scrolls = 0, sizes = [];
var list = document.getElementById('list');
function more() {
  pages++;
  for (var i = 0; i < 60; i++) {
    var d = document.createElement('div');
    d.textContent = 'item ' + pages + '.' + i;
    list.appendChild(d);
  }
}
more();
new IntersectionObserver(function (entries) {
  entries.forEach(function (e) {
    seen.push(e.isIntersecting ? 'in' + e.intersectionRatio : 'out' + e.intersectionRatio);
    if (e.isIntersecting && pages < 4) more();
  });
}).observe(document.getElementById('sentinel'));
new ResizeObserver(function (entries) {
  var e = entries[0];
  sizes.push(e.target.id + ' ' + (e.contentRect.width > 0) + ' ' + (e.borderBoxSize[0].blockSize > 0));
}).observe(list);
addEventListener('scroll', function (e) { if (e.target === document && e.bubbles) scrolls++; });
// The crawler starts once the first observation is in: that one must see the page
// unscrolled, with the sentinel below the fold.
setTimeout(async function () {
  var last = -1;
  for (var n = 0; n < 20; n++) {
    var h = document.scrollingElement.scrollHeight;
    if (h === last) break;
    last = h;
    scrollTo(0, h);
    await new Promise(function (r) { setTimeout(r, 20); });
  }
  document.body.setAttribute('data-r', [pages, seen.join('/'), scrolls > 0, sizes.join('/'),
    scrollY + innerHeight === document.documentElement.scrollHeight].join('|'));
}, 30);
</script>`


	// A loop, or no timer would run (run_html_page consumes it).
	loop := eventloop.init()
	result, output := lava.run_html_page(transmute([]byte)string(MARKUP), "<window-layout>", &loop)
	lava.result_destroy(&result)
	defer delete(output)
	testing.expectf(
		t,
		strings.contains(output, `data-r="4|in1/out0/in1/out0/in1/out0/in1|true|list true true|true"`),
		"feed: %s",
		output,
	)
}
