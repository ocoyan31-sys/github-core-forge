// Entrypoint for the forge: this file owns only the conversation with the trial
// environment, never the forge itself (that is app.ts and the modules behind it).
//
// The exchange, step by step:
//
//   * The environment's origin arrives as MAKEFUN_ENV_URL. It is the only way to
//     reach the environment, so when it is missing the process reports that and
//     exits 1 without doing anything else.
//   * The forge server is created and bound with listen(0), leaving the choice
//     of port to the kernel. Port 8080 belongs to the environment and is never
//     bound here.
//   * The bound port is announced with POST /register and a {"port": N} body.
//     A 200 means the environment took the address this request came from plus
//     N as the forge's base URL; a 409 means an earlier register already won
//     and is equally final. 400 and 405 are breaches of the contract and stop
//     the process; anything else (a refused connection, a timeout, an
//     unexpected status) is retried, because the environment may still be
//     starting up.
//   * GET /done is then polled. The environment answers immediately every
//     time — {"done": false} while its suite is running — so polling is a
//     loop of short requests, and the process leaves only once an answer says
//     {"done": true}.
//   * At that point the server is closed and the process exits 0, which is the
//     harness's cue to stop the environment and score its export.
//
// Retries everywhere share one patience: a wait that starts at 250 ms, doubles
// after each failure and never grows past 2 s, with 30 s allowed for any single
// request before it is given up as failed. No failure of the environment ever
// ends this process early — only the done signal does.
//
// The sole import is the forge's own createApp: no npm package, no Node
// built-in module and no model call is involved in the lifecycle.

import { createApp } from './app.ts';

/** Milliseconds one register or done request may run before it counts as failed. */
const PER_REQUEST_TIMEOUT_MS = 30_000;
/** The first retry wait; each later wait doubles it up to the ceiling. */
const FIRST_RETRY_WAIT_MS = 250;
const LONGEST_RETRY_WAIT_MS = 2_000;

/** The environment's origin with any trailing slashes removed, or '' when unset. */
function envOrigin(): string {
  return (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
}

/** Pause for `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before the next attempt, given how many attempts have
 * failed so far: FIRST_RETRY_WAIT_MS doubled per failure, capped at
 * LONGEST_RETRY_WAIT_MS.
 */
function waitAfter(failures: number): number {
  const doubled = FIRST_RETRY_WAIT_MS * 2 ** Math.min(failures, 8);
  return Math.min(LONGEST_RETRY_WAIT_MS, doubled);
}

/**
 * Announce `port` to the environment and return once it has accepted the
 * announcement (200) or an earlier announcement stands (409). Contract
 * breaches (400, 405) throw; every other outcome is retried indefinitely.
 */
async function announcePort(origin: string, port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let breach: Error | null = null;
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        breach = new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch {
      // A network failure or a timeout: the environment is not ready, retry.
    }
    if (breach !== null) throw breach;
    await pause(waitAfter(failures));
  }
}

/**
 * Poll the environment's /done endpoint until it answers {"done": true}.
 * Unsuccessful polls — a transport error, a non-OK status, a body that does
 * not say done — are simply polled again after the shared retry wait.
 */
async function awaitDone(origin: string): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answerable yet is the same as not done: keep polling.
    }
    await pause(waitAfter(failures));
  }
}

/**
 * The process's whole life: bind an ephemeral port, announce it, then wait
 * for the environment's done signal before closing the server.
 */
async function run(origin: string): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(origin, bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone(origin);
  server.close();
  process.stdout.write('[entry] done\n');
}

const origin = envOrigin();
if (origin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

try {
  await run(origin);
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
