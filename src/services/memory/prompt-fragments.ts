import nunjucks from 'nunjucks';

/**
 * Inlined here so it doesn't depend on a re-export from template-engine.
 * Mirrors the shape that MemoryService.search returns; consumers pass the
 * hits straight through to the prompt-fragment renderer.
 */
export interface MemoryHit {
  readonly id: string;
  readonly text: string;
  readonly score: number;
  readonly metadata: Record<string, unknown>;
}

/**
 * Memory prompt fragments — markdown blocks Clawndom prepends/appends
 * around an agent's rendered template when the matched route opts into
 * memory. Authored as TS template strings so they ship inside the
 * tsup bundle without a separate file-copy step.
 *
 * Edit the strings below, save, the build picks them up like any other
 * TS source change. The fragments are uniform across agents — every
 * memory-enabled route gets the same instructions; if we improve them,
 * every agent benefits without an agent-repo PR.
 */
const RETRIEVE_PREAMBLE_TEMPLATE = `---

# Memory — durable facts you know about this conversation

Below are facts you've recorded in past conversations — names, preferences, ongoing context, things this person has already told you. They were retrieved by semantic similarity to the current inbound, ranked by relevance. They are AUTHORITATIVE: if you say "I don't know" about something that's listed here, you are wrong.

\`\`\`
{{ memories }}
\`\`\`

If the block is empty, you have no specific prior context for this exact query (related context may exist elsewhere, but pre-fetch keys on the inbound text and won't surface it here — answer honestly that you don't know rather than invent).

How to use them when generating your reply:
- Weave relevant facts in naturally. Don't quote verbatim, don't list, don't say "I remember…" or "according to my notes" — just behave like someone who remembers.
- If a fact contradicts what the person just said in this turn, the person is the authority — update your model and respond accordingly, don't argue from notes.
- If the fact is sensitive (someone has died, a relationship ended, a diagnosis), match the tone. Don't be cheerful about it.
`;

const STORE_POSTAMBLE_TEMPLATE = `---

# Memory — recording new durable facts

If this turn surfaced a new durable fact you'd want to recall in a future, unrelated conversation, record it. The decision to store is yours; nothing in the run is automatically saved.

What counts as durable:
- DO record: "Chris's cat is named Porter", "Heather prefers email follow-ups before noon", "Piper handles the Wells Fargo reconciliation", "the office closes for spring break March 17–24".
- DO NOT record: "Chris said good morning", "the gmail watch is healthy", "Heather asked about today's schedule", anything client-PHI-related (HIPAA: never to memory either), anything you're uncertain is true.

If unsure, don't store. False negatives cost nothing; false positives pollute the namespace and surface as confidently-wrong context months later.

To record (Python, via the agency-tools client cloned at \`agency-tools/\`):

\`\`\`python
PYTHONPATH=../../agency-tools python3 <<'PY'
import os
from agency_tools.memory import store as memory_store, MemoryAPIError
try:
    memory_store.store(
        namespace='{{ memoryNamespace }}',
        text='<the durable fact, in your own words>',
        trace_id='{{ traceId }}',
        metadata={'source': '<provider:channel-or-thread>', 'recordedAt': '<iso8601-utc>'},
        agent_token=os.environ['CLAWNDOM_AGENT_TOKEN'],
    )
except MemoryAPIError as e:
    # Storage failure is non-blocking. Log and proceed.
    pass
PY
\`\`\`

Cap: up to 5 stores per run per namespace (server-enforced). The common case for a single turn is zero stores — only reach for this when you've genuinely learned something new and durable.
`;

/**
 * Memory prompt fragments — markdown blocks Clawndom prepends/appends
 * around an agent's rendered template when the matched route opts into
 * memory. The fragments live in `prompts/` next to this module so they
 * ship with the Clawndom build, not in any individual agent repo.
 *
 * Why fragments here, not in agent templates:
 *   - Memory instructions are infrastructure. Every memory-enabled route
 *     gets the same instructions; if we improve them, every agent
 *     benefits without an agent-repo PR.
 *   - Agents stay focused on their domain logic. The slack-chat template
 *     is about Slack chat, not about how to use memory.
 *   - Per-namespace customization happens via the `memoryNamespace` /
 *     `traceId` interpolations below — same fragments, different bound
 *     values.
 */

const fragmentEnvironment = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
});

interface PromptContext {
  memories: readonly MemoryHit[];
  memoryNamespace: string;
  traceId: string;
}

/**
 * Render the memory-recall block — appears at the BOTTOM of the prompt,
 * close to where the model generates output. Per Anthropic + OpenAI
 * prompt-engineering guidance, variable per-turn context should sit near
 * the user message (recency bias + cache efficiency); putting it at the
 * top buries it under the stable IDENTITY/SOUL/template prefix.
 */
export function renderMemoryRecallBlock(context: PromptContext): string {
  return fragmentEnvironment.renderString(RETRIEVE_PREAMBLE_TEMPLATE, {
    memories: formatMemories(context.memories),
  });
}

/**
 * Render the memory-storage block — appears once on the first turn of a
 * session (the storage instructions are stable; the agent learns them
 * once and remembers via the session JSONL on subsequent turns). Bound
 * with namespace + traceId for the agency_tools.memory.store snippet.
 */
export function renderMemoryStorageBlock(context: PromptContext): string {
  return fragmentEnvironment.renderString(STORE_POSTAMBLE_TEMPLATE, {
    memoryNamespace: context.memoryNamespace,
    traceId: context.traceId,
  });
}

function formatMemories(hits: readonly MemoryHit[]): string {
  if (hits.length === 0) return '(no relevant memories)';
  return hits.map((hit) => `- ${hit.text} [score: ${hit.score.toFixed(2)}]`).join('\n');
}
