import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type EntityKind = string;
export type EntityId = string;

export interface Entity {
  id: EntityId;
  kind: EntityKind;
  name: string;
  properties: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface Relation {
  from_id: EntityId;
  type: string;
  to_id: EntityId;
  properties: Record<string, unknown> | null;
  created_at: number;
}

export interface AuditRecord {
  id: number;
  ts: number;
  trace_id: string | null;
  actor: string | null;
  entity_id: EntityId;
  op: 'create' | 'update' | 'relate' | 'unrelate' | 'purge';
  diff: Record<string, unknown>;
}

export interface FindQuery {
  kinds?: EntityKind[];
  q?: string;
  related_to?: EntityId;
  relation_type?: string;
  text_match?: string;
  status?: string;
  order?: { field: 'created_at' | 'updated_at' | 'name'; dir: 'asc' | 'desc' };
  limit?: number;
}

export interface GetOptions {
  expand_relations?: boolean;
}

export interface ExpandedEntity extends Entity {
  outgoing?: Array<{ type: string; to_id: EntityId; properties: Record<string, unknown> | null }>;
  incoming?: Array<{ type: string; from_id: EntityId; properties: Record<string, unknown> | null }>;
}

export interface UpsertOptions {
  id?: EntityId;
  trace_id?: string | null;
  actor?: string | null;
}

export interface WriteContext {
  trace_id?: string | null;
  actor?: string | null;
}

export interface NaturalKeySpecification {
  fields: string[];
  normalize?: (value: unknown) => string | null;
}

export type NaturalKeyConfig = Record<EntityKind, NaturalKeySpecification>;

export interface IdPrefixConfig {
  [kind: EntityKind]: string;
}

export interface ValidationFailure {
  property: string;
  message: string;
  keyword?: string;
}

export interface SchemaValidatorContract {
  validate(
    kind: EntityKind,
    properties: Record<string, unknown>,
  ): { valid: boolean; errors: ValidationFailure[] };
}

export interface EntityStoreOptions {
  filePath: string;
  naturalKeys?: NaturalKeyConfig;
  idPrefixes?: IdPrefixConfig;
  validator?: SchemaValidatorContract;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  properties  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entities_kind   ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_name   ON entities(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(json_extract(properties, '$.status'));
CREATE INDEX IF NOT EXISTS idx_entities_kind_created ON entities(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS relations (
  from_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  properties  TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (from_id, type, to_id),
  FOREIGN KEY (from_id) REFERENCES entities(id),
  FOREIGN KEY (to_id)   REFERENCES entities(id)
);

CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type);
CREATE INDEX IF NOT EXISTS idx_relations_to   ON relations(to_id);

CREATE TABLE IF NOT EXISTS entity_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  trace_id    TEXT,
  actor       TEXT,
  entity_id   TEXT NOT NULL,
  op          TEXT NOT NULL,
  diff        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON entity_audit(entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts     ON entity_audit(ts);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  properties,
  content='entities',
  content_rowid='rowid'
);
`;

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS entities_fts_insert AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, properties) VALUES (new.rowid, new.properties);
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_delete AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, properties) VALUES ('delete', old.rowid, old.properties);
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_update AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, properties) VALUES ('delete', old.rowid, old.properties);
  INSERT INTO entities_fts(rowid, properties) VALUES (new.rowid, new.properties);
END;
`;

export class EntityStoreError extends Error {
  constructor(
    message: string,
    public code:
      | 'KIND_REQUIRED'
      | 'NATURAL_KEY_AMBIGUOUS'
      | 'ENTITY_NOT_FOUND'
      | 'RELATION_TARGET_MISSING'
      | 'INVALID_ID_FORMAT'
      | 'PURGE_REASON_REQUIRED'
      | 'SCHEMA_VALIDATION_FAILED',
    public details?: { errors: ValidationFailure[] },
  ) {
    super(message);
    this.name = 'EntityStoreError';
  }
}

const DEFAULT_ID_PREFIXES: IdPrefixConfig = {
  client: 'c_',
  contact: 'p_',
  memory: 'm_',
  interaction: 'i_',
};

export class EntityStore {
  private db: Database.Database;
  private naturalKeys: NaturalKeyConfig;
  private idPrefixes: IdPrefixConfig;
  private validator: SchemaValidatorContract | null;

  constructor(options: EntityStoreOptions) {
    this.db = new Database(options.filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.naturalKeys = options.naturalKeys ?? {};
    this.idPrefixes = { ...DEFAULT_ID_PREFIXES, ...options.idPrefixes };
    this.validator = options.validator ?? null;
    this.db.exec(SCHEMA);
    this.db.exec(FTS_TRIGGERS);
  }

  close(): void {
    this.db.close();
  }

  get database(): Database.Database {
    return this.db;
  }

  upsert(
    kind: EntityKind,
    name: string,
    properties: Record<string, unknown>,
    options: UpsertOptions = {},
  ): Entity {
    if (!kind) {
      throw new EntityStoreError('kind is required', 'KIND_REQUIRED');
    }
    if (this.validator !== null) {
      const result = this.validator.validate(kind, properties);
      if (!result.valid) {
        throw new EntityStoreError(
          `validation failed for kind '${kind}': ${result.errors
            .map((error) => `${error.property} ${error.message}`)
            .join('; ')}`,
          'SCHEMA_VALIDATION_FAILED',
          { errors: result.errors },
        );
      }
    }
    const now = Date.now();
    const naturalKey = this.computeNaturalKey(kind, properties);
    const suppliedId = options.id ?? null;
    let existingId: string | null = null;
    if (suppliedId !== null) {
      existingId = this.getRaw(suppliedId) === null ? null : suppliedId;
    } else if (naturalKey !== null) {
      existingId = this.findByNaturalKey(kind, naturalKey);
    }
    const tx = this.db.transaction(() => {
      if (existingId !== null) {
        const before = this.getRaw(existingId);
        if (before === null) {
          throw new EntityStoreError(
            `entity ${existingId} disappeared mid-upsert`,
            'ENTITY_NOT_FOUND',
          );
        }
        this.db
          .prepare(
            'UPDATE entities SET kind = ?, name = ?, properties = ?, updated_at = ? WHERE id = ?',
          )
          .run(kind, name, JSON.stringify(properties), now, existingId);
        this.writeAudit({
          ts: now,
          trace_id: options.trace_id ?? null,
          actor: options.actor ?? null,
          entity_id: existingId,
          op: 'update',
          diff: { before, after: { kind, name, properties } },
        });
        return existingId;
      }
      const newId = suppliedId ?? this.generateId(kind);
      this.db
        .prepare(
          'INSERT INTO entities (id, kind, name, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(newId, kind, name, JSON.stringify(properties), now, now);
      this.writeAudit({
        ts: now,
        trace_id: options.trace_id ?? null,
        actor: options.actor ?? null,
        entity_id: newId,
        op: 'create',
        diff: { before: null, after: { kind, name, properties } },
      });
      return newId;
    });
    const id = tx();
    const result = this.getRaw(id);
    if (result === null) {
      throw new EntityStoreError(`upsert returned id ${id} but lookup failed`, 'ENTITY_NOT_FOUND');
    }
    return result;
  }

  get(id: EntityId, options: GetOptions = {}): ExpandedEntity | null {
    const entity = this.getRaw(id);
    if (entity === null) return null;
    if (!options.expand_relations) return entity;
    const outgoing = this.db
      .prepare('SELECT type, to_id, properties FROM relations WHERE from_id = ?')
      .all(id) as Array<{ type: string; to_id: string; properties: string | null }>;
    const incoming = this.db
      .prepare('SELECT type, from_id, properties FROM relations WHERE to_id = ?')
      .all(id) as Array<{ type: string; from_id: string; properties: string | null }>;
    return {
      ...entity,
      outgoing: outgoing.map((r) => ({
        type: r.type,
        to_id: r.to_id,
        properties:
          r.properties === null ? null : (JSON.parse(r.properties) as Record<string, unknown>),
      })),
      incoming: incoming.map((r) => ({
        type: r.type,
        from_id: r.from_id,
        properties:
          r.properties === null ? null : (JSON.parse(r.properties) as Record<string, unknown>),
      })),
    };
  }

  find(query: FindQuery): Entity[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.kinds && query.kinds.length > 0) {
      where.push(`e.kind IN (${query.kinds.map(() => '?').join(',')})`);
      params.push(...query.kinds);
    }
    if (query.q !== undefined && query.q !== '') {
      where.push(
        `(LOWER(e.name) LIKE LOWER(?) OR EXISTS (SELECT 1 FROM json_each(json_extract(e.properties, '$.aliases')) WHERE LOWER(value) LIKE LOWER(?)))`,
      );
      params.push(`%${query.q}%`, `%${query.q}%`);
    }
    if (query.status !== undefined) {
      where.push(`json_extract(e.properties, '$.status') = ?`);
      params.push(query.status);
    }
    let joinClause = '';
    if (query.related_to !== undefined) {
      joinClause = `JOIN relations r ON r.from_id = e.id`;
      where.push('r.to_id = ?');
      params.push(query.related_to);
      if (query.relation_type !== undefined) {
        where.push('r.type = ?');
        params.push(query.relation_type);
      }
    }
    let ftsJoin = '';
    if (query.text_match !== undefined && query.text_match !== '') {
      ftsJoin = `JOIN entities_fts fts ON fts.rowid = e.rowid`;
      where.push('entities_fts MATCH ?');
      params.push(query.text_match);
    }
    const order = query.order ?? { field: 'created_at' as const, dir: 'desc' as const };
    const limit = query.limit ?? 50;
    const dirSql = order.dir === 'asc' ? 'ASC' : 'DESC';
    const sql = `
      SELECT DISTINCT e.id, e.kind, e.name, e.properties, e.created_at, e.updated_at, e.rowid
      FROM entities e
      ${joinClause}
      ${ftsJoin}
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.${order.field} ${dirSql}, e.rowid ${dirSql}
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params, limit) as Array<{
      id: string;
      kind: string;
      name: string;
      properties: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      properties: JSON.parse(r.properties) as Record<string, unknown>,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  relate(
    fromId: EntityId,
    type: string,
    toId: EntityId,
    properties: Record<string, unknown> | null = null,
    context: WriteContext = {},
  ): void {
    const now = Date.now();
    const fromExists = this.getRaw(fromId);
    const toExists = this.getRaw(toId);
    if (fromExists === null || toExists === null) {
      throw new EntityStoreError(
        `relation target missing: from=${fromId} to=${toId}`,
        'RELATION_TARGET_MISSING',
      );
    }
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO relations (from_id, type, to_id, properties, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(fromId, type, toId, properties === null ? null : JSON.stringify(properties), now);
      this.writeAudit({
        ts: now,
        trace_id: context.trace_id ?? null,
        actor: context.actor ?? null,
        entity_id: fromId,
        op: 'relate',
        diff: { type, to_id: toId, properties },
      });
    });
    tx();
  }

  unrelate(fromId: EntityId, type: string, toId: EntityId, context: WriteContext = {}): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const result = this.db
        .prepare('DELETE FROM relations WHERE from_id = ? AND type = ? AND to_id = ?')
        .run(fromId, type, toId);
      if (result.changes > 0) {
        this.writeAudit({
          ts: now,
          trace_id: context.trace_id ?? null,
          actor: context.actor ?? null,
          entity_id: fromId,
          op: 'unrelate',
          diff: { type, to_id: toId },
        });
      }
    });
    tx();
  }

  purge(id: EntityId, reason: string, context: WriteContext = {}): void {
    if (!reason || reason.trim() === '') {
      throw new EntityStoreError('purge requires a non-empty reason', 'PURGE_REASON_REQUIRED');
    }
    const now = Date.now();
    const entity = this.getRaw(id);
    if (entity === null) {
      throw new EntityStoreError(`entity ${id} not found`, 'ENTITY_NOT_FOUND');
    }
    const tx = this.db.transaction(() => {
      const outgoing = this.db
        .prepare('SELECT type, to_id, properties FROM relations WHERE from_id = ?')
        .all(id) as Array<{ type: string; to_id: string; properties: string | null }>;
      const incoming = this.db
        .prepare('SELECT type, from_id, properties FROM relations WHERE to_id = ?')
        .all(id) as Array<{ type: string; from_id: string; properties: string | null }>;
      this.db.prepare('DELETE FROM relations WHERE from_id = ?').run(id);
      this.db.prepare('DELETE FROM relations WHERE to_id = ?').run(id);
      this.db.prepare('DELETE FROM entities WHERE id = ?').run(id);
      this.writeAudit({
        ts: now,
        trace_id: context.trace_id ?? null,
        actor: context.actor ?? null,
        entity_id: id,
        op: 'purge',
        diff: {
          reason,
          purged_entity: entity,
          deleted_outgoing: outgoing,
          severed_incoming: incoming,
        },
      });
    });
    tx();
  }

  auditFor(entityId: EntityId, since?: number): AuditRecord[] {
    const sql =
      since !== undefined
        ? 'SELECT id, ts, trace_id, actor, entity_id, op, diff FROM entity_audit WHERE entity_id = ? AND ts >= ? ORDER BY ts DESC, id DESC'
        : 'SELECT id, ts, trace_id, actor, entity_id, op, diff FROM entity_audit WHERE entity_id = ? ORDER BY ts DESC, id DESC';
    const params: unknown[] = since !== undefined ? [entityId, since] : [entityId];
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      ts: number;
      trace_id: string | null;
      actor: string | null;
      entity_id: string;
      op: string;
      diff: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      trace_id: r.trace_id,
      actor: r.actor,
      entity_id: r.entity_id,
      op: r.op as AuditRecord['op'],
      diff: JSON.parse(r.diff) as Record<string, unknown>,
    }));
  }

  private getRaw(id: EntityId): Entity | null {
    const row = this.db
      .prepare(
        'SELECT id, kind, name, properties, created_at, updated_at FROM entities WHERE id = ?',
      )
      .get(id) as
      | undefined
      | {
          id: string;
          kind: string;
          name: string;
          properties: string;
          created_at: number;
          updated_at: number;
        };
    if (row === undefined) return null;
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      properties: JSON.parse(row.properties) as Record<string, unknown>,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private computeNaturalKey(kind: EntityKind, properties: Record<string, unknown>): string | null {
    const specification = this.naturalKeys[kind];
    if (specification === undefined) return null;
    const parts: string[] = [];
    for (const field of specification.fields) {
      const value = properties[field];
      if (value === undefined || value === null) return null;
      const normalized =
        specification.normalize === undefined ? String(value) : specification.normalize(value);
      if (normalized === null) return null;
      parts.push(normalized);
    }
    return parts.join('|');
  }

  private findByNaturalKey(kind: EntityKind, naturalKey: string): EntityId | null {
    const specification = this.naturalKeys[kind];
    if (specification === undefined) return null;
    const candidates = this.db
      .prepare('SELECT id, properties FROM entities WHERE kind = ?')
      .all(kind) as Array<{ id: string; properties: string }>;
    for (const candidate of candidates) {
      const properties = JSON.parse(candidate.properties) as Record<string, unknown>;
      const candidateKey = this.computeNaturalKey(kind, properties);
      if (candidateKey === naturalKey) return candidate.id;
    }
    return null;
  }

  private generateId(kind: EntityKind): EntityId {
    const prefix = this.idPrefixes[kind];
    if (prefix !== undefined) {
      return `${prefix}${randomUUID()}`;
    }
    return randomUUID();
  }

  private writeAudit(record: Omit<AuditRecord, 'id'>): void {
    this.db
      .prepare(
        'INSERT INTO entity_audit (ts, trace_id, actor, entity_id, op, diff) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.ts,
        record.trace_id,
        record.actor,
        record.entity_id,
        record.op,
        JSON.stringify(record.diff),
      );
  }
}
