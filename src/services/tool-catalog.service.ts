import type { ToolDescriptor } from './tools/descriptor';

/**
 * Public-facing tool descriptor. Drops the on-disk `directory` (operator
 * filesystem path) and exposes secrets by their declared contract only
 * (canonical kwarg name + alias list — never resolved values).
 */
export interface ToolCatalogEntry {
  readonly name: string;
  readonly reference: string;
  readonly description: string;
  readonly args: ToolDescriptor['args'];
  readonly secrets: readonly { readonly canonical: string; readonly aliases: readonly string[] }[];
}

/**
 * In-process aggregation of every tool descriptor loaded at boot. The
 * agent-loader pushes each `loadToolDescriptor` result here; the catalog
 * endpoints (`/api/tools/catalog`, `/api/agents/:agent/tools`) read from
 * it without re-parsing tool.yaml files at request time.
 */
class ToolCatalog {
  private readonly byAgent = new Map<string, Map<string, ToolCatalogEntry>>();
  private readonly global = new Map<string, ToolCatalogEntry>();

  register(agentName: string, descriptor: ToolDescriptor): void {
    const entry = makeEntry(descriptor);
    this.global.set(entry.reference, entry);

    let agentMap = this.byAgent.get(agentName);
    if (agentMap === undefined) {
      agentMap = new Map();
      this.byAgent.set(agentName, agentMap);
    }
    agentMap.set(entry.reference, entry);
  }

  list(): readonly ToolCatalogEntry[] {
    return [...this.global.values()];
  }

  listForAgent(agentName: string): readonly ToolCatalogEntry[] | undefined {
    const agentMap = this.byAgent.get(agentName);
    if (agentMap === undefined) return undefined;
    return [...agentMap.values()];
  }

  reset(): void {
    this.byAgent.clear();
    this.global.clear();
  }
}

function makeEntry(descriptor: ToolDescriptor): ToolCatalogEntry {
  return {
    name: descriptor.name,
    reference: descriptor.reference,
    description: descriptor.description,
    args: descriptor.args,
    secrets: descriptor.secrets.map((s) => ({ canonical: s.canonical, aliases: s.aliases })),
  };
}

let instance: ToolCatalog | null = null;

export function getToolCatalog(): ToolCatalog {
  if (instance === null) instance = new ToolCatalog();
  return instance;
}

export function resetToolCatalog(): void {
  instance = null;
}
