import type { EntityStore } from './entity-store.service';

export interface MentionMatch {
  entityId: string;
  matchedTerm: string;
}

export interface MentionExtractionResult {
  matched: MentionMatch[];
  ambiguous: Array<{ term: string; candidateCount: number }>;
}

export interface ExtractorOptions {
  store: EntityStore;
  kinds?: string[];
  minimumTermLength?: number;
}

const DEFAULT_MIN_LENGTH = 3;

export function extractMentions(text: string, options: ExtractorOptions): MentionExtractionResult {
  const kinds = options.kinds;
  const minimumLength = options.minimumTermLength ?? DEFAULT_MIN_LENGTH;

  const candidates = options.store.find({
    kinds,
    limit: 5000,
  });

  const index = new Map<string, string[]>();
  for (const entity of candidates) {
    const terms = collectTerms(entity);
    for (const rawTerm of terms) {
      const term = rawTerm.toLowerCase();
      if (term.length < minimumLength) continue;
      const ids = index.get(term) ?? [];
      if (!ids.includes(entity.id)) {
        ids.push(entity.id);
      }
      index.set(term, ids);
    }
  }

  const matched: MentionMatch[] = [];
  const ambiguous: Array<{ term: string; candidateCount: number }> = [];
  const seenEntityIds = new Set<string>();
  const lowerText = text.toLowerCase();

  for (const [term, ids] of index) {
    if (!lowerText.includes(term)) continue;
    if (!hasWordBoundary(lowerText, term)) continue;
    if (ids.length > 1) {
      ambiguous.push({ term, candidateCount: ids.length });
      continue;
    }
    const entityId = ids[0]!;
    if (seenEntityIds.has(entityId)) continue;
    seenEntityIds.add(entityId);
    matched.push({ entityId, matchedTerm: term });
  }

  return { matched, ambiguous };
}

function collectTerms(entity: { name: string; properties: Record<string, unknown> }): string[] {
  const terms: string[] = [entity.name];
  // Index each word of the name so that "Camilla" matches "Camilla
  // Asher". Multi-word matches are still possible because the full
  // name is in the index. Ambiguous tokens (e.g., two clients named
  // "Camilla") naturally surface in the ambiguous bucket because both
  // entity IDs share the same indexed term.
  for (const word of entity.name.split(/\s+/)) {
    if (word !== '' && word !== entity.name) terms.push(word);
  }
  const nickname = entity.properties['nickname'];
  if (typeof nickname === 'string' && nickname !== '') terms.push(nickname);
  const aliases = entity.properties['aliases'];
  if (Array.isArray(aliases)) {
    for (const alias of aliases) {
      if (typeof alias === 'string') terms.push(alias);
    }
  }
  return terms;
}

function hasWordBoundary(text: string, term: string): boolean {
  // Returns true if `term` appears in `text` at any position with
  // non-word characters on both sides. Iterates all occurrences,
  // not just the first, so a match later in the text isn't masked by
  // an earlier substring-match without proper boundaries.
  let cursor = 0;
  while (cursor <= text.length - term.length) {
    const index = text.indexOf(term, cursor);
    if (index === -1) return false;
    const before = index === 0 ? ' ' : text.charAt(index - 1);
    const after = index + term.length >= text.length ? ' ' : text.charAt(index + term.length);
    if (!isWordChar(before) && !isWordChar(after)) return true;
    cursor = index + 1;
  }
  return false;
}

function isWordChar(character: string): boolean {
  return /[a-z0-9_]/i.test(character);
}
