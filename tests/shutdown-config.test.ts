/**
 * Lifecycle / shutdown timeout configuration tests.
 *
 * Covers the three operational knobs that govern graceful self-shutdown and
 * downstream child cleanup:
 *   - CODE_EXECUTOR_CHILD_SHUTDOWN_TIMEOUT_MS (SIGTERM→SIGKILL grace per child)
 *   - CODE_EXECUTOR_PARENT_POLL_INTERVAL_MS  (parent-liveness poll cadence)
 *   - CODE_EXECUTOR_CLIENT_CLOSE_TIMEOUT_MS  (per-client close() timeout)
 *
 * Unlike getCharacterLimit()/getPoolConfig(), these getters are read on the
 * SHUTDOWN path, where throwing would abort the very cleanup they configure.
 * They therefore CLAMP out-of-range values and FALL BACK to the default on a
 * non-numeric value rather than throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getChildShutdownTimeoutMs,
  getParentPollIntervalMs,
  getClientCloseTimeoutMs,
  DEFAULT_CHILD_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_PARENT_POLL_INTERVAL_MS,
  DEFAULT_CLIENT_CLOSE_TIMEOUT_MS,
} from '../src/config/loader.js';

describe('Lifecycle shutdown configuration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CODE_EXECUTOR_CHILD_SHUTDOWN_TIMEOUT_MS;
    delete process.env.CODE_EXECUTOR_PARENT_POLL_INTERVAL_MS;
    delete process.env.CODE_EXECUTOR_CLIENT_CLOSE_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getChildShutdownTimeoutMs (default 30s, 1s..5min)', () => {
    it('should_returnDefault_when_envUnset', () => {
      expect(getChildShutdownTimeoutMs()).toBe(DEFAULT_CHILD_SHUTDOWN_TIMEOUT_MS);
      expect(DEFAULT_CHILD_SHUTDOWN_TIMEOUT_MS).toBe(30_000);
    });

    it('should_useEnvValue_when_validAndInRange', () => {
      process.env.CODE_EXECUTOR_CHILD_SHUTDOWN_TIMEOUT_MS = '120000';
      expect(getChildShutdownTimeoutMs()).toBe(120_000);
    });

    it('should_acceptFiveMinuteCeiling_when_atUpperBound', () => {
      process.env.CODE_EXECUTOR_CHILD_SHUTDOWN_TIMEOUT_MS = '300000';
      expect(getChildShutdownTimeoutMs()).toBe(300_000);
    });

    it('should_clampToMin_when_belowLowerBound', () => {
      process.env.CODE_EXECUTOR_CHILD_SHUTDOWN_TIMEOUT_MS = '10';
      expect(getChildShutdownTimeoutMs()).toBe(1_000);
    });

    it('should_clampToMax_when_aboveUpperBound', () => {
      process.env.CODE_EXECUTOR_CHILD_SHUTDOWN_TIMEOUT_MS = '999999999';
      expect(getChildShutdownTimeoutMs()).toBe(300_000);
    });

    it('should_fallBackToDefault_when_nonNumeric', () => {
      process.env.CODE_EXECUTOR_CHILD_SHUTDOWN_TIMEOUT_MS = 'not-a-number';
      expect(getChildShutdownTimeoutMs()).toBe(DEFAULT_CHILD_SHUTDOWN_TIMEOUT_MS);
    });
  });

  describe('getParentPollIntervalMs (default 2s, 0.5s..60s)', () => {
    it('should_returnDefault_when_envUnset', () => {
      expect(getParentPollIntervalMs()).toBe(DEFAULT_PARENT_POLL_INTERVAL_MS);
      expect(DEFAULT_PARENT_POLL_INTERVAL_MS).toBe(2_000);
    });

    it('should_useEnvValue_when_validAndInRange', () => {
      process.env.CODE_EXECUTOR_PARENT_POLL_INTERVAL_MS = '5000';
      expect(getParentPollIntervalMs()).toBe(5_000);
    });

    it('should_clampToMin_when_belowLowerBound', () => {
      process.env.CODE_EXECUTOR_PARENT_POLL_INTERVAL_MS = '50';
      expect(getParentPollIntervalMs()).toBe(500);
    });

    it('should_clampToMax_when_aboveUpperBound', () => {
      process.env.CODE_EXECUTOR_PARENT_POLL_INTERVAL_MS = '120000';
      expect(getParentPollIntervalMs()).toBe(60_000);
    });

    it('should_fallBackToDefault_when_nonNumeric', () => {
      process.env.CODE_EXECUTOR_PARENT_POLL_INTERVAL_MS = 'xyz';
      expect(getParentPollIntervalMs()).toBe(DEFAULT_PARENT_POLL_INTERVAL_MS);
    });
  });

  describe('getClientCloseTimeoutMs (default 2s, 0.25s..30s)', () => {
    it('should_returnDefault_when_envUnset', () => {
      expect(getClientCloseTimeoutMs()).toBe(DEFAULT_CLIENT_CLOSE_TIMEOUT_MS);
      expect(DEFAULT_CLIENT_CLOSE_TIMEOUT_MS).toBe(2_000);
    });

    it('should_useEnvValue_when_validAndInRange', () => {
      process.env.CODE_EXECUTOR_CLIENT_CLOSE_TIMEOUT_MS = '5000';
      expect(getClientCloseTimeoutMs()).toBe(5_000);
    });

    it('should_clampToMin_when_belowLowerBound', () => {
      process.env.CODE_EXECUTOR_CLIENT_CLOSE_TIMEOUT_MS = '10';
      expect(getClientCloseTimeoutMs()).toBe(250);
    });

    it('should_clampToMax_when_aboveUpperBound', () => {
      process.env.CODE_EXECUTOR_CLIENT_CLOSE_TIMEOUT_MS = '99999';
      expect(getClientCloseTimeoutMs()).toBe(30_000);
    });

    it('should_fallBackToDefault_when_nonNumeric', () => {
      process.env.CODE_EXECUTOR_CLIENT_CLOSE_TIMEOUT_MS = '';
      expect(getClientCloseTimeoutMs()).toBe(DEFAULT_CLIENT_CLOSE_TIMEOUT_MS);
    });
  });
});
