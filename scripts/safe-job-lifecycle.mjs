/**
 * Safe, adapter-agnostic job lifecycle helpers.
 *
 * This module deliberately does not call any external service or execute work.
 * A caller must persist the returned state and enforce the run token before
 * applying side effects. Use with a mock adapter until a separately reviewed
 * integration is approved.
 */

export const JOB_STATES = Object.freeze([
  "queued",
  "running",
  "paused",
  "interrupted",
  "completed",
  "cancelled",
  "reset",
  "blocked",
]);

const TERMINAL_STATES = new Set(["completed", "cancelled", "reset", "blocked"]);

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

export function hasReachedTarget(job) {
  const target = Number(job?.targetAmount);
  const completed = Number(job?.confirmedAmount);
  return Number.isFinite(target) && target >= 0 &&
    Number.isFinite(completed) && completed >= target;
}

/**
 * Only an explicitly recoverable, non-terminal job can resume.
 * Server refusals / policy blocks must be represented as "blocked", never
 * "interrupted", so startup recovery cannot turn them into automatic retries.
 */
export function canAutoResume(job) {
  if (!job || isTerminalState(job.state) || job.cancelRequested === true) return false;
  if (hasReachedTarget(job)) return false;
  if (job.state !== "paused" && job.state !== "interrupted") return false;
  return job.failureKind !== "server_refusal" && job.failureKind !== "policy";
}

/** Increment on reset/cancel to invalidate any stale worker holding an old token. */
export function nextRunToken(job) {
  const current = Number.isSafeInteger(job?.runToken) && job.runToken >= 0
    ? job.runToken
    : 0;
  return current + 1;
}

export function isCurrentRun(job, workerToken) {
  return Boolean(
    job &&
    Number.isSafeInteger(workerToken) &&
    workerToken === job.runToken &&
    !isTerminalState(job.state) &&
    job.cancelRequested !== true
  );
}

/**
 * Apply lifecycle-only commands without executing a job.
 * The caller remains responsible for durable atomic writes (compare-and-set)
 * so concurrent workers cannot overwrite a newer reset/cancel.
 */
export function applyLifecycleCommand(job, command) {
  if (!job || typeof job !== "object") throw new TypeError("job is required");

  switch (command) {
    case "pause":
      if (isTerminalState(job.state)) return job;
      return { ...job, state: "paused" };
    case "interrupt":
      if (isTerminalState(job.state)) return job;
      return { ...job, state: "interrupted" };
    case "resume":
      if (!canAutoResume(job)) return job;
      return { ...job, state: "running", failureKind: undefined };
    case "cancel":
      return {
        ...job,
        state: "cancelled",
        cancelRequested: true,
        runToken: nextRunToken(job),
      };
    case "reset":
      return {
        ...job,
        state: "queued",
        confirmedAmount: 0,
        cancelRequested: false,
        failureKind: undefined,
        runToken: nextRunToken(job),
      };
    case "complete":
      if (!hasReachedTarget(job)) return job;
      return { ...job, state: "completed", confirmedAmount: Number(job.targetAmount) };
    case "block":
      return {
        ...job,
        state: "blocked",
        failureKind: "server_refusal",
        runToken: nextRunToken(job),
      };
    default:
      throw new Error(`Unsupported lifecycle command: ${command}`);
  }
}
