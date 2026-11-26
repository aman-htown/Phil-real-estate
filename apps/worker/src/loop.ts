import { log } from "./log";

/** Runs `fn` forever with a pause between runs. Busy ticks (fn returned > 0) loop again immediately. */
export function startLoop(name: string, intervalMs: number, fn: () => Promise<number | void>) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const tick = async () => {
    if (stopped) return;
    let busy = false;
    running = (async () => {
      try {
        busy = ((await fn()) ?? 0) > 0;
      } catch (err) {
        log.error({ err, loop: name }, "Loop tick failed");
      }
    })();
    await running;
    if (!stopped) timer = setTimeout(tick, busy ? 0 : intervalMs);
  };
  timer = setTimeout(tick, 0);

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
