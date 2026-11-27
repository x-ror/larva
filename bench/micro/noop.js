// Startup target: the smallest possible page script. bench/run.mjs spawns
// `lava run` on this repeatedly and times the whole process (boot, Window global
// install, teardown), so it measures runtime start-up rather than in-script work.
// It is run WITHOUT the harness and must emit no ##BENCH## line.
void 0;
