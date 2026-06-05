/**
 * Selectable protocol-bench phases.
 *
 *   NEARBYTES_PROTOCOL_MATRIX=local,chat-replay
 *   node run-local.mjs --matrix local,chat
 *
 * Tokens (comma-separated, case-insensitive):
 *   local | lan     — topology hint (category comes from the runner script)
 *   chat-sync       — cumulative chat publish/expect targets
 *   chat-replay     — replay checkpoints (mid + final); seeds chat if needed
 *   chat            — alias for chat-sync + chat-replay
 *   file            — 16 MiB file bursts
 *   all             — chat + file
 *
 * Default for engine migration: local,chat-replay (loopback, chat replay only).
 */

export function parseProtocolMatrix(argv = process.argv) {
  const fromArg = () => {
    const i = argv.indexOf('--matrix');
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const raw =
    process.env.NEARBYTES_PROTOCOL_MATRIX?.trim() ||
    fromArg() ||
    'local,chat-replay';
  const tokens = new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  const all = tokens.has('all');
  const chatSync = all || tokens.has('chat') || tokens.has('chat-sync');
  const chatReplay = all || tokens.has('chat') || tokens.has('chat-replay');
  const file = all || tokens.has('file');

  return {
    raw,
    tokens: [...tokens],
    chatSync,
    chatReplay,
    file,
    /** Replay without cumulative chat sweep (auto-seeds one batch first). */
    replayOnly: chatReplay && !chatSync,
  };
}
