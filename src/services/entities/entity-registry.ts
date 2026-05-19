import { join } from 'node:path';

import { EntityResolver } from './entity-resolver.service';
import {
  type LoadedWorkspace,
  SchemaValidator,
  loadWorkspaceSchemas,
} from './entity-schema.service';
import { EntityStore } from './entity-store.service';

export interface AgentEntityContext {
  store: EntityStore;
  resolver: EntityResolver;
  workspace: LoadedWorkspace;
  validator: SchemaValidator;
}

export interface AgentEntityDescriptor {
  agentName: string;
  workspacePath: string;
  databasePath?: string;
}

const DEFAULT_DATABASE_ROOT = '/home/ubuntu';

export class EntityRegistry {
  private contexts = new Map<string, AgentEntityContext>();

  register(descriptor: AgentEntityDescriptor): AgentEntityContext {
    const databasePath =
      descriptor.databasePath ??
      join(DEFAULT_DATABASE_ROOT, `.clawndom-${descriptor.agentName}`, 'entities.db');
    const workspace = loadWorkspaceSchemas(descriptor.workspacePath);
    const validator = new SchemaValidator(workspace.schemas);
    const store = new EntityStore({
      filePath: databasePath,
      naturalKeys: workspace.naturalKeys,
      validator,
    });
    const resolver = new EntityResolver({
      store,
      identityProperties: workspace.identityProperties,
    });
    const context: AgentEntityContext = { store, resolver, workspace, validator };
    this.contexts.set(descriptor.agentName, context);
    return context;
  }

  get(agentName: string): AgentEntityContext | null {
    return this.contexts.get(agentName) ?? null;
  }

  has(agentName: string): boolean {
    return this.contexts.has(agentName);
  }

  agentNames(): string[] {
    return Array.from(this.contexts.keys());
  }

  closeAll(): void {
    for (const context of this.contexts.values()) {
      context.store.close();
    }
    this.contexts.clear();
  }
}

let singleton: EntityRegistry | null = null;

export function getEntityRegistry(): EntityRegistry {
  if (singleton === null) {
    singleton = new EntityRegistry();
  }
  return singleton;
}

export function resetEntityRegistry(): void {
  if (singleton !== null) {
    singleton.closeAll();
    singleton = null;
  }
}
