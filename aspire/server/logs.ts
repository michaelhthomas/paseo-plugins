import { parseAnsi } from "../shared/ansi";
import type { AspireLogs, LogLine } from "../shared/aspire";
import { followAspire } from "./cli";
import { normalizePath } from "./state";

// Lines per resource replayed on connect (the CLI applies the tail per resource).
const INITIAL_TAIL = 2_000;
// One buffer holds every resource, so keep plenty for quiet resources next to chatty ones.
const MAX_BUFFER = 20_000;
// Long enough that leaving the logs panel for a while and coming back resumes the same stream.
const IDLE_DISPOSE_MS = 5 * 60_000;
// `aspire logs --follow` replays the backlog as a burst with no end marker (measured: the burst starts ~150–250ms
// after spawn, with gaps of at most ~15ms between lines). Treat the backlog as complete once the stream goes quiet
// briefly, if it never produces anything, or after a cap for resources that log nonstop.
const BACKLOG_QUIET_MS = 100;
const BACKLOG_EMPTY_MS = 1_000;
const BACKLOG_MAX_MS = 3_000;
// While the backlog is loading, a read waits for it instead of returning empty, so the panel gets it the moment it's
// complete rather than on its next poll.
const BACKLOG_WAIT_MS = BACKLOG_MAX_MS + 1_000;

type Stream = {
  generation: number;
  lines: LogLine[];
  nextSeq: number;
  lastRead: number;
  /** False while the initial backlog is still arriving; readers get nothing until it's all here. */
  ready: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
  /** Reads waiting for the backlog to complete. */
  readyWaiters: (() => void)[];
  connectedAt: number;
  dispose: () => void;
};

/** One `aspire logs --follow` (all resources) per app host, kept alive while a client keeps reading it. */
const streams = new Map<string, Stream>();
let generations = 0;
let sweeper: ReturnType<typeof setInterval> | null = null;

function markReadyAfter(stream: Stream, ms: number) {
  if (stream.ready) return;
  if (stream.readyTimer) clearTimeout(stream.readyTimer);
  stream.readyTimer = setTimeout(() => {
    stream.ready = true;
    stream.readyTimer = null;
    for (const resolve of stream.readyWaiters.splice(0)) resolve();
  }, ms);
}

function awaitBacklog(stream: Stream) {
  stream.ready = false;
  stream.connectedAt = Date.now();
  markReadyAfter(stream, BACKLOG_EMPTY_MS);
}

function open(appHostPath: string): Stream {
  const args = ["logs", "--apphost", appHostPath, "--format", "Json", "--follow", "-n", String(INITIAL_TAIL), "-t"];
  const stream: Stream = {
    generation: ++generations,
    lines: [],
    nextSeq: 1,
    lastRead: Date.now(),
    ready: false,
    readyTimer: null,
    readyWaiters: [],
    connectedAt: Date.now(),
    dispose: () => {},
  };
  awaitBacklog(stream);
  const stop = followAspire(
    args,
    (value) => {
      if (!value || typeof value !== "object") return;
      const entry = value as Record<string, unknown>;
      if (typeof entry.content !== "string") return;
      const { text, segments } = parseAnsi(entry.content);
      stream.lines.push({
        seq: stream.nextSeq++,
        resource: typeof entry.resourceName === "string" ? entry.resourceName : "",
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
        text,
        segments,
        stderr: entry.isError === true,
      });
      if (stream.lines.length > MAX_BUFFER) stream.lines.splice(0, stream.lines.length - MAX_BUFFER);
      if (!stream.ready) {
        const remaining = BACKLOG_MAX_MS - (Date.now() - stream.connectedAt);
        markReadyAfter(stream, Math.max(0, Math.min(BACKLOG_QUIET_MS, remaining)));
      }
    },
    () => {
      // A reconnect replays the tail, so start a fresh generation rather than duplicating lines.
      stream.generation = ++generations;
      stream.lines = [];
      stream.nextSeq = 1;
      awaitBacklog(stream);
    },
  );
  stream.dispose = () => {
    if (stream.readyTimer) clearTimeout(stream.readyTimer);
    for (const resolve of stream.readyWaiters.splice(0)) resolve();
    stop();
  };
  return stream;
}

function sweep() {
  for (const [key, stream] of streams) {
    if (Date.now() - stream.lastRead > IDLE_DISPOSE_MS) {
      stream.dispose();
      streams.delete(key);
    }
  }
}

function waitForBacklog(stream: Stream) {
  if (stream.ready) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, BACKLOG_WAIT_MS);
    stream.readyWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function readLogs(
  appHostPath: string,
  running: boolean,
  generation: number | null,
  after: number,
): Promise<AspireLogs> {
  const key = normalizePath(appHostPath);
  if (!running) {
    streams.get(key)?.dispose();
    streams.delete(key);
    return { running: false, loading: false, generation: 0, lines: [], cursor: 0, error: null };
  }
  let stream = streams.get(key);
  if (!stream) {
    stream = open(appHostPath);
    streams.set(key, stream);
  }
  sweeper ??= setInterval(sweep, IDLE_DISPOSE_MS / 2);
  stream.lastRead = Date.now();
  await waitForBacklog(stream);
  const from = generation === stream.generation ? after : 0;
  if (!stream.ready) return { running: true, loading: true, generation: stream.generation, lines: [], cursor: from, error: null };
  const start = stream.lines.findIndex((line) => line.seq > from);
  const lines = start < 0 ? [] : stream.lines.slice(start);
  return {
    running: true,
    loading: false,
    generation: stream.generation,
    lines,
    cursor: lines.length ? lines[lines.length - 1].seq : from,
    error: null,
  };
}

export function disposeLogs() {
  for (const stream of streams.values()) stream.dispose();
  streams.clear();
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
