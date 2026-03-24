import { runOnce } from '../../src/scheduler';

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import logger from '../../src/logger';

describe('runOnce', () => {
  it('should execute task and log', async () => {
    const mockTask = jest.fn().mockResolvedValue(undefined);

    await runOnce(mockTask);

    expect(mockTask).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'Manual run triggered',
      expect.objectContaining({ runId: expect.any(String) })
    );
  });

  it('should log completion with duration', async () => {
    const mockTask = jest.fn().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    await runOnce(mockTask);

    expect(logger.info).toHaveBeenCalledWith(
      'Manual run completed',
      expect.objectContaining({ durationMs: expect.any(Number) })
    );
  });

  it('should log error if task fails', async () => {
    const mockTask = jest.fn().mockRejectedValue(new Error('Task failed'));

    await expect(runOnce(mockTask)).rejects.toThrow('Task failed');

    expect(logger.error).toHaveBeenCalledWith(
      'Manual run failed',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });
});
