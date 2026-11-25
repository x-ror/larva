# Event Loop Tests

These tests pin modern Node 22+ event-loop ordering for Lava. The native Linux
backend uses io_uring when available and falls back to epoll, with JSC
microtasks drained before returning to polling.

The JavaScript cases are run with Node as the oracle. The Odin package tests
exercise Lava's deterministic event-loop core directly.

Covered behavior:

- `process.nextTick` precedence over promise and queued microtasks
- FIFO microtask ordering and nested microtask draining
- timer cancellation and stable timer ordering
- microtasks drained between timer callbacks
- nested timers deferred to a later turn
- a timer that falls due during the timers phase deferred behind that turn's immediates
- interval cancellation
- `node:timers/promises` abort behavior
- I/O callback handoff into the immediate/check phase
