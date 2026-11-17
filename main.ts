// The entrypoint: bring the forge up, tell the suite where it lives, and stay
// put until the suite says it is finished. This file serves nothing itself —
// createApp in app.ts owns the whole HTTP surface. All this file does is run
// the handshake the wire contract asks for: bind, register, wait for done,
// shut down.
//
// The suite owns port 8080, so this process never picks a port of its own:
// listen(0) lets the kernel hand it a free one, and that number is the one
// that gets registered. A register that answers 409 only means some other
// entry got there first; it changes nothing, and this process waits for done
// exactly like any other. The done endpoint answers at once while the suite
// still runs, so this file polls it on a short timer instead of holding one
// request open, and it never leaves before the suite answers done: true.

import { createApp } from './app.ts';

// The variable naming the suite's origin. Without it there is nothing to
// register with, so the process gives up at once.
const ENV_URL_VAR = 'MAKEFUN_ENV_URL';

// How long to wait before the next done poll, and the longest that wait
// grows to while polls keep failing.
const FIRST_WAIT_MS = 250;
const LONGEST_WAIT_MS = 2000;

// How long one done poll may take before it is abandoned and retried.
const POLL_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function suiteOrigin(): string | null {
  const origin = process.env[ENV_URL_VAR];
  if (origin === undefined || origin === '') return null;
  return origin.replace(/\/+$/, '');
}

function bindFreePort(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the forge bound without a usable address'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function register(origin: string, port: number): Promise<void> {
  let waitMs = FIRST_WAIT_MS;
  for (;;) {
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      // A 200 takes the registration; a 409 says another entry already holds
      // it, and this process waits for done all the same. Anything else is
      // worth one more try after a pause.
      if (response.ok || response.status === 409) return;
    } catch {
      // The suite is not reachable yet; try again after a pause.
    }
    await sleep(waitMs);
    waitMs = Math.min(LONGEST_WAIT_MS, waitMs * 2);
  }
}

async function waitForDone(origin: string): Promise<void> {
  let waitMs = FIRST_WAIT_MS;
  for (;;) {
    let finished = false;
    try {
      const response = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        finished = body.done === true;
      }
    } catch {
      // A failed or slow poll is no answer at all: ask again after a pause,
      // waiting longer each time the polls keep failing.
    }
    if (finished) return;
    await sleep(waitMs);
    waitMs = Math.min(LONGEST_WAIT_MS, waitMs * 2);
  }
}

async function shutdown(server: ReturnType<typeof createApp>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function run(): Promise<number> {
  const origin = suiteOrigin();
  if (origin === null) {
    console.error(`${ENV_URL_VAR} is not set: there is no suite to register with`);
    return 1;
  }
  const server = createApp();
  let port: number;
  try {
    port = await bindFreePort(server);
  } catch (error) {
    console.error(`the forge could not bind: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  await register(origin, port);
  await waitForDone(origin);
  await shutdown(server);
  return 0;
}

process.exit(await run());
