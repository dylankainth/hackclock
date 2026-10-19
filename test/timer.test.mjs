import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/core/timer.js';

const timer = { id: 'a', label: 'Pitch', durationMs: 180000, warnMs: 30000 };

test('start/pause/resume keeps the remaining time exact', () => {
  let run = T.idleRun(timer);
  run = T.start(run, 1_000_000);
  assert.equal(run.status, 'running');
  assert.equal(run.endsAt, 1_180_000);
  assert.equal(T.remainingAt(run, 1_060_000), 120000);

  run = T.pause(run, 1_060_000);
  assert.equal(run.status, 'paused');
  assert.equal(run.remainingMs, 120000);
  // Paused time does not drain.
  assert.equal(T.remainingAt(run, 9_999_999), 120000);

  run = T.start(run, 2_000_000);
  assert.equal(run.endsAt, 2_120_000);
});

test('start on a running timer and pause on a paused timer are no-ops', () => {
  const running = T.start(T.idleRun(timer), 0);
  assert.equal(T.start(running, 5000), running);
  const idle = T.idleRun(timer);
  assert.equal(T.pause(idle, 5000), idle);
});

test('toggle flips between running and paused', () => {
  let run = T.toggle(T.idleRun(timer), 0);
  assert.equal(run.status, 'running');
  run = T.toggle(run, 10_000);
  assert.equal(run.status, 'paused');
  assert.equal(run.remainingMs, 170000);
});

test('adjust moves the end time while running and the remainder while paused', () => {
  let run = T.start(T.idleRun(timer), 0);
  run = T.adjust(run, 60_000, 30_000);
  assert.equal(run.endsAt, 240_000);
  assert.equal(T.remainingAt(run, 30_000), 210_000);
  assert.equal(run.totalMs, 210_000, 'progress total grows when time is added past the slot');

  let paused = T.pause(T.start(T.idleRun(timer), 0), 100_000);
  paused = T.adjust(paused, -10_000, 100_000);
  assert.equal(paused.remainingMs, 70_000);
  assert.equal(paused.status, 'paused');
});

test('reset returns to idle at the full slot', () => {
  const run = T.reset(T.start(T.idleRun(timer), 0), timer);
  assert.deepEqual(run, T.idleRun(timer));
});

test('phases', () => {
  assert.equal(T.phaseOf('idle', 5000, 30000), 'idle');
  assert.equal(T.phaseOf('running', 120000, 30000), 'ok');
  assert.equal(T.phaseOf('running', 30000, 30000), 'warn');
  assert.equal(T.phaseOf('running', 10000, 30000), 'critical');
  assert.equal(T.phaseOf('running', 1, 30000), 'critical');
  assert.equal(T.phaseOf('running', 0, 30000), 'over');
  assert.equal(T.phaseOf('paused', -5000, 30000), 'over');
});

test('a short warning still gets an amber stage before red', () => {
  // warn at 6s: amber from 6s, red from 3s
  assert.equal(T.phaseOf('running', 8000, 6000), 'ok');
  assert.equal(T.phaseOf('running', 6000, 6000), 'warn');
  assert.equal(T.phaseOf('running', 3000, 6000), 'critical');
  // warn disabled: stay ok until time is up
  assert.equal(T.phaseOf('running', 3000, 0), 'ok');
  assert.equal(T.phaseOf('running', 0, 0), 'over');
});

test('clock parts: counts down rounding up, then counts overtime upward', () => {
  assert.equal(T.formatText(180000), '3:00');
  assert.equal(T.formatText(179001), '3:00');
  assert.equal(T.formatText(179000), '2:59');
  assert.equal(T.formatText(1), '0:01');
  assert.equal(T.formatText(0), '0:00');
  assert.equal(T.formatText(-999), '0:00');
  assert.equal(T.formatText(-1000), '+0:01');
  assert.equal(T.formatText(-65_000), '+1:05');
  assert.equal(T.formatText(3600_000 + 5_000), '1:00:05');
  assert.equal(T.formatText(-3600_000), '+1:00:00');
  assert.equal(T.clockParts(-999).over, true);
  assert.equal(T.clockParts(-999).plus, false);
});

test('default warn threshold is 20% clamped to 5-30s', () => {
  assert.equal(T.defaultWarn(10_000), 5_000);
  assert.equal(T.defaultWarn(60_000), 12_000);
  assert.equal(T.defaultWarn(600_000), 30_000);
});

test('snapshot carries everything a display needs and nothing else', () => {
  const run = T.start(T.idleRun(timer), 1000);
  const s = T.snapshot({ v: 7, timer, run, next: 'Q&A' });
  assert.deepEqual(Object.keys(s).sort(), [
    'durationMs', 'endsAt', 'label', 'next', 'remainingMs', 'status', 'totalMs', 'v', 'warnMs',
  ]);
  assert.equal(s.endsAt, 181000);
  // JSON round trip is lossless.
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});
