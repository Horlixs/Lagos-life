import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLifecycleCommand,
  canAutoResume,
  hasReachedTarget,
  isCurrentRun,
  nextRunToken,
} from "./safe-job-lifecycle.mjs";

const sample = (overrides = {}) => ({
  id: "mock-order-1",
  state: "interrupted",
  targetAmount: 100,
  confirmedAmount: 40,
  runToken: 2,
  cancelRequested: false,
  ...overrides,
});

test("interrupted job resumes while preserving confirmed progress", () => {
  const job = sample();
  assert.equal(canAutoResume(job), true);
  const resumed = applyLifecycleCommand(job, "resume");
  assert.equal(resumed.state, "running");
  assert.equal(resumed.confirmedAmount, 40);
});

test("server refusals are blocked from automatic recovery", () => {
  assert.equal(canAutoResume(sample({ failureKind: "server_refusal" })), false);
  assert.equal(canAutoResume(sample({ failureKind: "policy" })), false);
  const blocked = applyLifecycleCommand(sample(), "block");
  assert.equal(blocked.state, "blocked");
  assert.equal(canAutoResume(blocked), false);
});

test("cancel and reset invalidate the old worker token", () => {
  const job = sample();
  const cancelled = applyLifecycleCommand(job, "cancel");
  assert.equal(cancelled.state, "cancelled");
  assert.equal(isCurrentRun(cancelled, job.runToken), false);

  const reset = applyLifecycleCommand(job, "reset");
  assert.equal(reset.state, "queued");
  assert.equal(reset.confirmedAmount, 0);
  assert.equal(reset.runToken, nextRunToken(job));
  assert.equal(isCurrentRun(reset, job.runToken), false);
});

test("completion requires confirmed progress to meet the target", () => {
  const short = sample({ confirmedAmount: 99 });
  assert.equal(hasReachedTarget(short), false);
  assert.equal(applyLifecycleCommand(short, "complete"), short);

  const reached = sample({ confirmedAmount: 100 });
  assert.equal(hasReachedTarget(reached), true);
  const completed = applyLifecycleCommand(reached, "complete");
  assert.equal(completed.state, "completed");
  assert.equal(completed.confirmedAmount, 100);
  assert.equal(canAutoResume(completed), false);
});

test("paused jobs can resume, but cancelled or completed jobs cannot", () => {
  assert.equal(canAutoResume(sample({ state: "paused" })), true);
  assert.equal(canAutoResume(sample({ state: "cancelled" })), false);
  assert.equal(canAutoResume(sample({ state: "completed" })), false);
  assert.equal(canAutoResume(sample({ cancelRequested: true })), false);
});

test("unsupported commands fail loudly", () => {
  assert.throws(() => applyLifecycleCommand(sample(), "retry-everything"));
});
