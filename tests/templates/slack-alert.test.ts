import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { renderTemplate } from '../../src/lib/template/template-engine';

const TEMPLATE_PATH = resolve(__dirname, '../../src/templates/slack-alert.njk');

async function loadTemplate(): Promise<string> {
  return readFile(TEMPLATE_PATH, 'utf-8');
}

describe('slack-alert template', () => {
  const samplePayload = {
    type: 'event_callback',
    event: {
      type: 'message',
      ts: '1712345678.123456',
      channel: 'C08UVJDJZTL',
      blocks: [
        {
          type: 'section',
          text: { text: '[PRODUCTION] Pipeline failure: invoice-processing' },
        },
        {
          type: 'section',
          text: { text: 'Request ID: req-abc-123' },
        },
        {
          type: 'section',
          text: { text: 'Execution time: 12.5s' },
        },
        {
          type: 'section',
          text: { text: 'Started: 2026-04-04T10:00:00Z | Failed: 2026-04-04T10:00:12Z' },
        },
        {
          type: 'section',
          text: { text: 'Step: validate-input' },
        },
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_preformatted',
              elements: [
                { type: 'text', text: 'Error: ValidationError\n  at validate (input.ts:42)' },
              ],
            },
          ],
        },
        {
          type: 'divider',
        },
        {
          type: 'section',
          text: { text: '```{"eventId":"evt-123","source":"scheduler"}```' },
        },
      ],
    },
  };

  it('should render the template with a sample payload', async () => {
    const template = await loadTemplate();
    const rendered = await renderTemplate(template, samplePayload, __dirname);

    expect(rendered.body).toContain('production');
    expect(rendered.body).toContain('[PRODUCTION] Pipeline failure: invoice-processing');
    expect(rendered.body).toContain('Request ID: req-abc-123');
    expect(rendered.body).toContain('Execution time: 12.5s');
    expect(rendered.body).toContain('validate-input');
    expect(rendered.body).toContain('ValidationError');
  });

  it('should include the raw payload JSON', async () => {
    const template = await loadTemplate();
    const rendered = await renderTemplate(template, samplePayload, __dirname);

    expect(rendered.body).toContain('"type": "event_callback"');
    expect(rendered.body).toContain('```json');
  });

  it('should map channel to correct environment', async () => {
    const template = await loadTemplate();

    const devPayload = {
      ...samplePayload,
      event: { ...samplePayload.event, channel: 'C08V6MV0VNV' },
    };
    const rendered = await renderTemplate(template, devPayload, __dirname);
    expect(rendered.body).toContain('development');
  });

  it('should handle missing blocks gracefully', async () => {
    const template = await loadTemplate();
    const minimalPayload = {
      type: 'event_callback',
      event: { type: 'message', ts: '1.0', channel: 'C08V6MV0VNV' },
    };
    const rendered = await renderTemplate(template, minimalPayload, __dirname);
    expect(rendered.body).toContain('development');
    expect(rendered.body).toContain('Raw Event Payload');
  });
});
