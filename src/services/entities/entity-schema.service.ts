import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import type { NaturalKeyConfig } from './entity-store.service';

export interface JSONSchemaProperty {
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: unknown[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
}

export interface EntityKindSchema {
  $id?: string;
  title?: string;
  description?: string;
  type: 'object';
  required?: string[];
  properties: Record<string, JSONSchemaProperty>;
  'x-natural-keys'?: string[];
  'x-natural-key-fields'?: string[];
}

export interface RelationDeclaration {
  from: string;
  to: string;
  description?: string;
  properties?: Record<string, JSONSchemaProperty>;
}

export type RelationsConfig = Record<string, RelationDeclaration>;

export interface ValidationError {
  property: string;
  message: string;
  keyword?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface IdentityPropertyIndex {
  byFormat: Record<string, Array<{ kind: string; property: string }>>;
  byPropertyName: Record<string, Array<{ kind: string; property: string }>>;
}

export interface LoadedWorkspace {
  schemas: Record<string, EntityKindSchema>;
  relations: RelationsConfig;
  naturalKeys: NaturalKeyConfig;
  identityProperties: IdentityPropertyIndex;
}

export class SchemaLoaderError extends Error {
  constructor(
    message: string,
    public code:
      | 'WORKSPACE_NOT_FOUND'
      | 'SCHEMA_PARSE_ERROR'
      | 'RELATIONS_PARSE_ERROR'
      | 'INVALID_SCHEMA',
  ) {
    super(message);
    this.name = 'SchemaLoaderError';
  }
}

const KIND_SUFFIX = '.schema.json';

const IDENTITY_PROPERTY_NAMES = ['slack_user_id', 'oidc_subject'];

export function loadWorkspaceSchemas(workspacePath: string): LoadedWorkspace {
  const schemasDir = join(workspacePath, 'schemas');
  const relationsPath = join(workspacePath, 'relations.json');

  if (!existsSync(workspacePath)) {
    throw new SchemaLoaderError(
      `workspace path does not exist: ${workspacePath}`,
      'WORKSPACE_NOT_FOUND',
    );
  }

  const schemas: Record<string, EntityKindSchema> = {};
  if (existsSync(schemasDir)) {
    const files = readdirSync(schemasDir).filter((f) => f.endsWith(KIND_SUFFIX));
    for (const file of files) {
      const kind = file.slice(0, -KIND_SUFFIX.length);
      const filePath = join(schemasDir, file);
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as EntityKindSchema;
        if (parsed.type !== 'object' || typeof parsed.properties !== 'object') {
          throw new SchemaLoaderError(
            `schema ${kind} must be a JSON Schema object with properties`,
            'INVALID_SCHEMA',
          );
        }
        schemas[kind] = parsed;
      } catch (error) {
        if (error instanceof SchemaLoaderError) throw error;
        throw new SchemaLoaderError(
          `failed to parse ${filePath}: ${(error as Error).message}`,
          'SCHEMA_PARSE_ERROR',
        );
      }
    }
  }

  let relations: RelationsConfig = {};
  if (existsSync(relationsPath)) {
    try {
      relations = JSON.parse(readFileSync(relationsPath, 'utf-8')) as RelationsConfig;
    } catch (error) {
      throw new SchemaLoaderError(
        `failed to parse ${relationsPath}: ${(error as Error).message}`,
        'RELATIONS_PARSE_ERROR',
      );
    }
  }

  return {
    schemas,
    relations,
    naturalKeys: buildNaturalKeyConfig(schemas),
    identityProperties: buildIdentityPropertyIndex(schemas),
  };
}

function buildNaturalKeyConfig(schemas: Record<string, EntityKindSchema>): NaturalKeyConfig {
  const config: NaturalKeyConfig = {};
  for (const [kind, schema] of Object.entries(schemas)) {
    const fields = schema['x-natural-keys'] ?? schema['x-natural-key-fields'];
    if (fields === undefined || fields.length === 0) continue;
    const isEmailField = (field: string): boolean => {
      const propertyDef = schema.properties[field];
      return propertyDef?.format === 'email';
    };
    config[kind] = {
      fields,
      normalize: (value): string | null => {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed === '' ? null : trimmed.toLowerCase();
      },
    };
    // Override normalize for non-string-only natural keys: if any field
    // is non-email and might contain mixed types, the default lowercase
    // is fine; if any field is email, lowercase is still correct. The
    // simple normalizer above handles both cases.
    void isEmailField;
  }
  return config;
}

function buildIdentityPropertyIndex(
  schemas: Record<string, EntityKindSchema>,
): IdentityPropertyIndex {
  const byFormat: Record<string, Array<{ kind: string; property: string }>> = {};
  const byPropertyName: Record<string, Array<{ kind: string; property: string }>> = {};

  for (const [kind, schema] of Object.entries(schemas)) {
    for (const [propertyName, propertyDef] of Object.entries(schema.properties)) {
      if (propertyDef.format !== undefined) {
        const list = byFormat[propertyDef.format] ?? [];
        list.push({ kind, property: propertyName });
        byFormat[propertyDef.format] = list;
      }
      if (IDENTITY_PROPERTY_NAMES.includes(propertyName)) {
        const list = byPropertyName[propertyName] ?? [];
        list.push({ kind, property: propertyName });
        byPropertyName[propertyName] = list;
      }
    }
  }

  return { byFormat, byPropertyName };
}

export class SchemaValidator {
  private ajv: Ajv;
  private validators: Map<string, ValidateFunction>;

  constructor(schemas: Record<string, EntityKindSchema>) {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);
    this.validators = new Map();
    for (const [kind, schema] of Object.entries(schemas)) {
      this.validators.set(kind, this.ajv.compile(schema));
    }
  }

  validate(kind: string, properties: Record<string, unknown>): ValidationResult {
    const validator = this.validators.get(kind);
    if (validator === undefined) {
      return { valid: true, errors: [] };
    }
    const valid = validator(properties);
    if (valid) {
      return { valid: true, errors: [] };
    }
    const errors: ValidationError[] = (validator.errors ?? []).map((error) => ({
      property:
        error.instancePath === ''
          ? ((error.params as { missingProperty?: string }).missingProperty ?? '<root>')
          : error.instancePath,
      message: error.message ?? 'validation failed',
      keyword: error.keyword,
    }));
    return { valid: false, errors };
  }
}
