import { resetConfig } from '../src/config';

// Clean up singletons before each test file
beforeEach(() => {
  resetConfig();
});

// Set test environment variable
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MIN_AGE_HOURS = process.env.MIN_AGE_HOURS || '72';

// Mock console.error to avoid noise during tests, but keep actual errors
const originalError = console.error;
beforeAll(() => {
  console.error = (...args: any[]) => {
    // Only log if it's not a known noisy warning
    const message = args[0];
    if (typeof message === 'string' && message.includes('ExperimentalWarning')) {
      return;
    }
    originalError.call(console, ...args);
  };
});

afterAll(() => {
  console.error = originalError;
});
