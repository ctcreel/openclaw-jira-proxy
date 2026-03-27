import { resetSettings } from '../src/config';
import { resetLogging } from '../src/lib/logging';

// Set test environment defaults
process.env.NODE_ENV = 'local';
process.env.DB_HOST = 'localhost';
process.env.DB_USER = '';
process.env.DB_PASS = '';
process.env.DB_NAME = 'test';
process.env.LOG_FORMAT = 'human';

beforeEach(() => {
  resetSettings();
  resetLogging();
});
