import { setTimeout as sleep } from "node:timers/promises";

/** Polls `check` every `intervalMs` until it holds; rejects after `timeoutMs`. */
export const waitUntil = async (
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for a condition`);
    await sleep(intervalMs);
  }
};
