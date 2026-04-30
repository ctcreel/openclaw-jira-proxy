import { describe, expect, it } from 'vitest';

import {
  renderRetrievePreamble,
  renderStorePostamble,
  type MemoryHit,
} from '../../../src/services/memory/prompt-fragments';

const NS = 'test-ns';
const TRACE = 'trace-1';

const sampleHits: MemoryHit[] = [
  { id: '1', text: 'Chris has a cat named Porter', score: 0.92, metadata: {} },
  { id: '2', text: 'Heather prefers email follow-ups before noon', score: 0.78, metadata: {} },
];

describe('renderRetrievePreamble', () => {
  it('formats hits as bullet lines with score', () => {
    const output = renderRetrievePreamble({
      memories: sampleHits,
      memoryNamespace: NS,
      traceId: TRACE,
    });
    expect(output).toContain('- Chris has a cat named Porter [score: 0.92]');
    expect(output).toContain('- Heather prefers email follow-ups before noon [score: 0.78]');
    expect(output).toContain('Memory — what you already know');
  });

  it('renders an explicit empty marker when there are no hits', () => {
    const output = renderRetrievePreamble({
      memories: [],
      memoryNamespace: NS,
      traceId: TRACE,
    });
    expect(output).toContain('(no relevant memories)');
  });

  it('does not leak namespace or traceId into the preamble (those belong in the postamble)', () => {
    const output = renderRetrievePreamble({
      memories: sampleHits,
      memoryNamespace: NS,
      traceId: TRACE,
    });
    expect(output).not.toContain(NS);
    expect(output).not.toContain(TRACE);
  });
});

describe('renderStorePostamble', () => {
  it('binds namespace and traceId into the store snippet', () => {
    const output = renderStorePostamble({
      memories: [],
      memoryNamespace: 'winston-personal',
      traceId: 'job-42',
    });
    expect(output).toContain("namespace='winston-personal'");
    expect(output).toContain("trace_id='job-42'");
  });

  it('contains the do/do-not guidance and rate-limit reminder', () => {
    const output = renderStorePostamble({
      memories: [],
      memoryNamespace: NS,
      traceId: TRACE,
    });
    expect(output).toMatch(/DO record:/);
    expect(output).toMatch(/DO NOT record:/);
    expect(output).toMatch(/5 stores per run/);
  });

  it('warns about HIPAA / never-store-PHI', () => {
    const output = renderStorePostamble({
      memories: [],
      memoryNamespace: NS,
      traceId: TRACE,
    });
    expect(output).toMatch(/HIPAA/);
  });
});
