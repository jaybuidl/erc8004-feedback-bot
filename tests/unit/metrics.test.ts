import { jest } from '@jest/globals';

// Mock config
jest.mock('../../src/config', () => ({
  getConfig: jest.fn().mockReturnValue({
    NODE_ENV: 'test',
    ENABLE_METRICS: false,
    METRICS_PORT: 3000,
  }),
  resetConfig: jest.fn(),
}));

// Mock logger
jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock prom-client
jest.mock('prom-client', () => {
  class MockCounter {
    inc = jest.fn();
    observe = jest.fn();
  }
  class MockGauge {
    set = jest.fn();
  }
  class MockHistogram {
    observe = jest.fn();
  }
  const mockRegister = {
    clear: jest.fn(),
    registerMetric: jest.fn(),
    metrics: jest.fn().mockReturnValue('# mock metrics'),
    contentType: 'text/plain; version=0.0.4',
  };
  return {
    __esModule: true,
    default: {
      Counter: MockCounter,
      Gauge: MockGauge,
      Histogram: MockHistogram,
      register: mockRegister,
    },
  };
});

// Mock express
jest.mock('express', () => {
  const mockExpress = jest.fn().mockImplementation(() => ({
    get: jest.fn(),
    listen: jest.fn((_port: number, cb: () => void) => {
      const server = {
        once: jest.fn(),
        close: jest.fn((closeCb: () => void) => closeCb()),
      };
      queueMicrotask(cb);
      return server;
    }),
  }));
  return {
    __esModule: true,
    default: mockExpress,
  };
});

import { getConfig } from '../../src/config';
import { MetricsService } from '../../src/metrics';
import type { OrchestratorStats } from '../../src/types';

// Helper to create stub metric object
const makeMetricStub = () => ({
  inc: jest.fn(),
  observe: jest.fn(),
  set: jest.fn(),
});

describe('MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    jest.resetAllMocks(); // Reset mock implementations and call history
    // Restore express mock implementation after reset (since resetMocks clears it)
    const expressMock = require('express') as any;
    expressMock.default.mockImplementation(() => ({
      get: jest.fn(),
      listen: jest.fn((_port: number, cb: () => void) => {
        const server = {
          once: jest.fn(),
          close: jest.fn((closeCb: () => void) => closeCb()),
        };
        queueMicrotask(cb);
        return server;
      }),
    }));

    (getConfig as jest.Mock).mockReturnValue({
      NODE_ENV: 'test',
      ENABLE_METRICS: false,
      METRICS_PORT: 3000,
    });
    metrics = new MetricsService();

    // Replace all metric instances with stubs to avoid mock implementation issues
    (metrics as any).runsTotal = makeMetricStub();
    (metrics as any).runDuration = makeMetricStub();
    (metrics as any).eligibleAgents = makeMetricStub();
    (metrics as any).feedbackSent = makeMetricStub();
    (metrics as any).transactionsSent = makeMetricStub();
    (metrics as any).errorsTotal = makeMetricStub();
  });

  describe('init', () => {
    it('should skip initialization if metrics disabled', async () => {
      (getConfig as jest.Mock).mockReturnValue({
        ...(getConfig as any).mock.defaultValue,
        ENABLE_METRICS: false,
      });

      await metrics.init();

      expect((metrics as any).initialized).toBe(false);
    });

    it('should register all metrics and start server when enabled', async () => {
      (getConfig as jest.Mock).mockReturnValue({
        NODE_ENV: 'test',
        ENABLE_METRICS: true,
        METRICS_PORT: 3000,
      });

      const loggerMock = require('../../src/logger') as any;
      await metrics.init();

      // Ensure no errors were logged
      expect(loggerMock.error).not.toHaveBeenCalled();

      expect((metrics as any).initialized).toBe(true);
      const serverAny = (metrics as any).server;
      expect(serverAny).not.toBeNull();
      expect(serverAny).not.toBeUndefined();
      const server = serverAny;
      expect(typeof server.close).toBe('function');
      const expressMock = require('express') as any;
      const app = expressMock.default.mock.results[0].value;
      expect(typeof app.get).toBe('function');
      // The real prom-client register will have been called via mocked register
      const promClient = require('prom-client') as any;
      expect(promClient.default.register.registerMetric).toHaveBeenCalled();
    });

    it('should log error and NOT set initialized if registerMetric throws', async () => {
      const mockLoggerError = jest.fn();
      // Re-mock logger to capture error calls
      const loggerMock = require('../../src/logger') as any;
      loggerMock.error = mockLoggerError;

      (getConfig as jest.Mock).mockReturnValue({
        NODE_ENV: 'test',
        ENABLE_METRICS: true,
        METRICS_PORT: 3000,
      });

      // Make the first registerMetric call throw
      const promClient = require('prom-client') as any;
      const registerMetricMock = promClient.default.register.registerMetric;
      registerMetricMock.mockImplementationOnce(() => {
        throw new Error('Registration failed');
      });

      await metrics.init();

      expect(mockLoggerError).toHaveBeenCalledWith(
        'Failed to start metrics server',
        expect.objectContaining({ error: expect.any(Error) })
      );
      expect((metrics as any).initialized).toBe(false);
    });
  });

  describe('recordRun', () => {
    it('increments runsTotal and observes runDuration', () => {
      const stats: OrchestratorStats = {
        totalEvents: 1,
        eligibleAgents: 2,
        feedbackSent: 3,
        errorsCount: 0,
        runId: 'run-1',
        durationMs: 123.456,
      };
      metrics.recordRun(stats, true);

      const runsTotal = (metrics as any).runsTotal as any;
      expect(runsTotal.inc).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success' })
      );

      const runDuration = (metrics as any).runDuration as any;
      expect(runDuration.observe).toHaveBeenCalledWith(0.123456);
    });

    it('sets eligibleAgents when available', () => {
      const stats: OrchestratorStats = {
        totalEvents: 5,
        eligibleAgents: 3,
        feedbackSent: 0,
        errorsCount: 0,
        runId: 'run-2',
        durationMs: 50,
      };
      metrics.recordRun(stats, false);

      const eligibleAgents = (metrics as any).eligibleAgents as any;
      expect(eligibleAgents.set).toHaveBeenCalledWith(3);
    });

    it('does NOT call eligibleAgents.set when eligibleAgents is undefined', () => {
      const stats: OrchestratorStats = {
        totalEvents: 5,
        feedbackSent: 0,
        errorsCount: 0,
        runId: 'run-3',
        durationMs: 50,
        // eligibleAgents is undefined - use type assertion to bypass
        eligibleAgents: undefined as any,
      };
      metrics.recordRun(stats, true);

      const eligibleAgents = (metrics as any).eligibleAgents as any;
      expect(eligibleAgents.set).not.toHaveBeenCalled();
    });
  });

  describe('recordFeedbackSent', () => {
    it('increments feedbackSent counter', () => {
      metrics.recordFeedbackSent(5);
      const feedbackSent = (metrics as any).feedbackSent as any;
      expect(feedbackSent.inc).toHaveBeenCalledWith(5);
    });
  });

  describe('recordTransaction', () => {
    it('increments transactionsSent with status', () => {
      metrics.recordTransaction('success');
      const tr = (metrics as any).transactionsSent as any;
      expect(tr.inc).toHaveBeenCalledWith({ status: 'success' });

      metrics.recordTransaction('failed');
      expect(tr.inc).toHaveBeenCalledWith({ status: 'failed' });

      metrics.recordTransaction('dry-run');
      expect(tr.inc).toHaveBeenCalledWith({ status: 'dry-run' });
    });
  });

  describe('recordError', () => {
    it('increments errorsTotal with type', () => {
      metrics.recordError('goldsky');
      const err = (metrics as any).errorsTotal as any;
      expect(err.inc).toHaveBeenCalledWith({ type: 'goldsky' });
    });
  });

  describe('shutdown', () => {
    it('closes metrics server', async () => {
      // We'll stub the server close method
      (metrics as any).server = { close: jest.fn((cb: any) => cb()) };
      await metrics.shutdown();
      expect((metrics as any).server.close).toHaveBeenCalled();
    });

    it('handles shutdown when not initialized', async () => {
      (metrics as any).server = null;
      await metrics.shutdown(); // should not throw
    });
  });

  describe('/metrics route error handling', () => {
    it('should return 500 if client.register.metrics throws', async () => {
      (getConfig as jest.Mock).mockReturnValue({
        NODE_ENV: 'test',
        ENABLE_METRICS: true,
        METRICS_PORT: 3000,
      });

      // Initialize server
      await metrics.init();
      const server = (metrics as any).server;
      const expressMock = require('express') as any;
      const app = expressMock.default.mock.results[0].value;
      expect(server).not.toBeNull();

      // Mock client.register.metrics to throw
      const promClient = require('prom-client') as any;
      promClient.default.register.metrics = jest.fn().mockImplementation(() => {
        throw new Error('Metrics generation failed');
      });

      // Create a mock request and response
      const req: any = {};
      const res: any = {
        set: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
        end: jest.fn(),
      };

      // Find the /metrics route handler
      const metricsRoute = app.get.mock.calls.find(
        (call: any[]) => call[0] === '/metrics'
      );
      expect(metricsRoute).toBeDefined();
      const handler = metricsRoute[1];

      // Call the handler
      await handler(req, res);

      // Verify error logged and 500 response
      const loggerMock = require('../../src/logger') as any;
      expect(loggerMock.error).toHaveBeenCalledWith(
        'Error generating metrics',
        expect.objectContaining({ error: expect.any(String) })
      );
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.end).toHaveBeenCalled();
    });
  });
});
