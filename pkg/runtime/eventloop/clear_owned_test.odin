package eventloop

import "core:testing"

// clear_timeout_owned is how clearTimeout/clearInterval/clearImmediate reach the loop
// (#92): handle ids come from one per-loop counter shared with runtime-internal timers
// (TLS handshake, net drain, pkg/http transfer deadlines), so an id alone does not say
// whose handle it is. The owner is the handle's dispose hook. These tests cover the
// three places a cancel can land — a heap timer, a queued immediate, the running
// handle — with a foreign dispose (must be a no-op) and the owning one (must cancel).

Owned_Probe :: struct {
	id:            Timer_ID,
	fires:         int,
	dispose_count: int,
	// The dispose the running callback hands to clear_timeout_owned for itself.
	clear_with:    Dispose,
}

owned_probe_dispose :: proc(user_data: rawptr) {
	(cast(^Owned_Probe)user_data).dispose_count += 1
}

// foreign_dispose is some other owner's hook; it must never be called here.
foreign_dispose :: proc(user_data: rawptr) {
	panic("foreign_dispose must never run: it owns no handle in these tests")
}

owned_probe_fire :: proc(loop: ^Loop, user_data: rawptr) {
	(cast(^Owned_Probe)user_data).fires += 1
}

// owned_probe_self_clear cancels its own interval through clear_timeout_owned, then
// stops it unconditionally on the third fire so a foreign-owner run still terminates.
owned_probe_self_clear :: proc(loop: ^Loop, user_data: rawptr) {
	p := cast(^Owned_Probe)user_data
	p.fires += 1
	clear_timeout_owned(loop, p.id, p.clear_with)

	if p.fires >= 3 {
		clear_interval(loop, p.id)
	}
}

@(test)
clear_owned_heap_timer_respects_owner :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	p := Owned_Probe{}
	p.id = set_timeout(&loop, owned_probe_fire, 5, &p, owned_probe_dispose)

	testing.expect(t, !clear_timeout_owned(&loop, p.id, foreign_dispose), "foreign owner must not cancel a heap timer")
	testing.expect(t, !clear_timeout_owned(&loop, p.id, nil), "nil owner must not cancel a heap timer")
	testing.expect(t, run_until_idle(&loop))
	testing.expect_value(t, p.fires, 1)
	testing.expect_value(t, p.dispose_count, 0)

	q := Owned_Probe{}
	q.id = set_timeout(&loop, owned_probe_fire, 5, &q, owned_probe_dispose)
	testing.expect(t, clear_timeout_owned(&loop, q.id, owned_probe_dispose))
	testing.expect(t, !run_until_idle(&loop))
	testing.expect_value(t, q.fires, 0)
	testing.expect_value(t, q.dispose_count, 1)
}

@(test)
clear_owned_immediate_respects_owner :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	p := Owned_Probe{}
	p.id = set_immediate(&loop, owned_probe_fire, &p, owned_probe_dispose)

	testing.expect(t, !clear_timeout_owned(&loop, p.id, foreign_dispose), "foreign owner must not cancel an immediate")
	testing.expect(t, run_until_idle(&loop))
	testing.expect_value(t, p.fires, 1)
	testing.expect_value(t, p.dispose_count, 0)

	q := Owned_Probe{}
	q.id = set_immediate(&loop, owned_probe_fire, &q, owned_probe_dispose)
	testing.expect(t, clear_timeout_owned(&loop, q.id, owned_probe_dispose))
	testing.expect(t, !run_until_idle(&loop))
	testing.expect_value(t, q.fires, 0)
	testing.expect_value(t, q.dispose_count, 1)
}

@(test)
clear_owned_running_timer_respects_owner :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	// Foreign owner from inside its own callback: the interval is re-armed and runs
	// until the unconditional clear on the third fire.
	p := Owned_Probe{clear_with = foreign_dispose}
	p.id = set_interval(&loop, owned_probe_self_clear, 5, &p, owned_probe_dispose)
	testing.expect(t, run_until_idle(&loop))
	testing.expect_value(t, p.fires, 3)
	testing.expect_value(t, p.dispose_count, 1)

	// Owning dispose: the self-cancel lands on the first fire, as clearInterval(self).
	q := Owned_Probe{clear_with = owned_probe_dispose}
	q.id = set_interval(&loop, owned_probe_self_clear, 5, &q, owned_probe_dispose)
	testing.expect(t, run_until_idle(&loop))
	testing.expect_value(t, q.fires, 1)
	testing.expect_value(t, q.dispose_count, 1)
	testing.expect_value(t, pending_count(&loop), 0)
}
