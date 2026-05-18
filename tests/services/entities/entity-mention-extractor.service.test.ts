import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractMentions } from '../../../src/services/entities/entity-mention-extractor.service';
import { EntityStore } from '../../../src/services/entities/entity-store.service';

let tempDir: string;
let store: EntityStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'clawndom-mention-extractor-'));
  store = new EntityStore({
    filePath: join(tempDir, 'entities.db'),
    naturalKeys: {
      client: {
        fields: ['legal_name'],
        normalize: (v): string | null => (typeof v === 'string' ? v.trim().toLowerCase() : null),
      },
    },
  });
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('extractMentions', () => {
  it('matches a single-token name', () => {
    const ari = store.upsert('client', 'Ari Goolsby', {
      legal_name: 'Ariel Goolsby',
      nickname: 'Ari',
      status: 'active',
    });
    const result = extractMentions('Ari had a great session today', { store });
    expect(result.matched.some((match) => match.entityId === ari.id)).toBe(true);
  });

  it('matches an alias term', () => {
    const alan = store.upsert('client', 'Alan Hu', {
      legal_name: 'Alan Hu',
      aliases: ['AIS AH'],
      status: 'active',
    });
    const result = extractMentions('AIS AH is on the schedule', { store });
    expect(result.matched.some((match) => match.entityId === alan.id)).toBe(true);
  });

  it('skips an ambiguous match', () => {
    store.upsert('client', 'Camilla Asher', {
      legal_name: 'Camilla Asher',
      status: 'active',
    });
    store.upsert('client', 'Camilla Smith', {
      legal_name: 'Camilla Smith',
      status: 'active',
    });
    const result = extractMentions('Camilla had a great session', { store });
    // bare "Camilla" hits both entities; should be in ambiguous, not matched
    expect(result.matched).toEqual([]);
    expect(result.ambiguous.some((entry) => entry.term === 'camilla')).toBe(true);
  });

  it('matches the longer name when both names are mentioned together', () => {
    const asher = store.upsert('client', 'Camilla Asher', {
      legal_name: 'Camilla Asher',
      status: 'active',
    });
    store.upsert('client', 'Camilla Smith', {
      legal_name: 'Camilla Smith',
      status: 'active',
    });
    const result = extractMentions('Working with Camilla Asher today', { store });
    expect(result.matched.some((match) => match.entityId === asher.id)).toBe(true);
  });

  it('requires word boundaries', () => {
    store.upsert('client', 'Sam', {
      legal_name: 'Sam',
      status: 'active',
    });
    // "Sam" inside "Samuel" should NOT match
    const result = extractMentions('Working with Samuel today', { store });
    expect(result.matched).toEqual([]);
  });

  it('ignores tokens below minimum length', () => {
    store.upsert('client', 'X', {
      legal_name: 'X',
      status: 'active',
    });
    const result = extractMentions('X is here', { store });
    expect(result.matched).toEqual([]);
  });
});
