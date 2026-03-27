import { resetSettings } from '../src/config';
import { resetLogging } from '../src/lib/logging';

process.env.NODE_ENV = 'local';
process.env.JIRA_HMAC_SECRET = 'test-hmac-secret';
process.env.OPENCLAW_TOKEN = 'test-openclaw-token';
process.env.LOG_FORMAT = 'human';

beforeEach(() => {
  resetSettings();
  resetLogging();
});
