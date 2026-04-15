import { resetSettings } from '../src/config';
import { resetLogging } from '../src/lib/logging';
import { resetRunners } from '../src/runners/registry';
import { resetSecretProviders } from '../src/secrets/registry';

process.env.NODE_ENV = 'local';
process.env.OPENCLAW_TOKEN = 'test-openclaw-token';
process.env.LOG_FORMAT = 'human';
process.env.PROVIDERS_CONFIG = JSON.stringify([
  {
    name: 'test-provider',
    routePath: '/hooks/test',
    hmacSecret: 'test-hmac-secret',
    signatureStrategy: 'websub',
    openclawHookUrl: 'http://127.0.0.1:18789/hooks/test',
  },
]);

beforeEach(() => {
  resetSettings();
  resetLogging();
  resetRunners();
  resetSecretProviders();
});
