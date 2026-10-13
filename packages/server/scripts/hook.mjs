#!/usr/bin/env node
// Claude Code hook command: forwards the hook's stdin JSON to the Orchestrator backend.
// Configured per session through `claude --settings`; relies on ORCH_URL and ORCH_SESSION_ID
// from the environment. It must never fail loudly or block the agent:
// every error is swallowed and the process always exits with 0.

const TIMEOUT_MS = 5000;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const { ORCH_URL, ORCH_SESSION_ID } = process.env;
  if (!ORCH_URL || !ORCH_SESSION_ID) return;

  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (payload === null || typeof payload !== 'object') return;

  await fetch(new URL('/api/hooks', ORCH_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sessionId: ORCH_SESSION_ID, payload }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
