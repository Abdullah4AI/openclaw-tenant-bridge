import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AccessGrant,
  ContextDelta,
  MemoryRecord,
  RecallQuery,
  RecallResult,
  RecallSurface,
  TenantBridgeState,
} from "./types.js";

export type CleanupResult = {
  deletedRecordIds: string[];
};

export interface TenantBridgeStore {
  getRecordByIdempotency(params: {
    tenantId: string;
    idempotencyKey: string;
  }): Promise<MemoryRecord | null>;
  saveRecord(record: MemoryRecord): Promise<MemoryRecord>;
  retrieve(query: RecallQuery): Promise<RecallResult>;
  upsertAccessGrant(grant: AccessGrant): Promise<AccessGrant>;
  promoteRecords(params: {
    tenantId: string;
    userId: string;
    recordIds: string[];
    surface?: RecallSurface;
  }): Promise<MemoryRecord[]>;
  listRecords(params: {
    tenantId: string;
    userId?: string;
    surfaces?: RecallSurface[];
  }): Promise<MemoryRecord[]>;
  cleanup(params: { now: Date }): Promise<CleanupResult>;
  close(): Promise<void>;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

function scoreRecord(params: { query: string; record: MemoryRecord }): number {
  if (!params.query.trim()) {
    return 0;
  }
  const queryTerms = new Set(tokenize(params.query));
  const contentTerms = tokenize(`${params.record.content} ${params.record.tags.join(" ")}`);
  if (queryTerms.size === 0 || contentTerms.length === 0) {
    return 0;
  }
  let hits = 0;
  for (const term of contentTerms) {
    if (queryTerms.has(term)) {
      hits += 1;
    }
  }
  if (hits === 0) {
    return 0;
  }
  const surfaceBoost =
    params.record.surface === "durable" ? 0.5 : params.record.surface === "artifact" ? 0.2 : 0;
  const recencyBoost =
    Math.max(
      0,
      1 - (Date.now() - Date.parse(params.record.updatedAt)) / (7 * 24 * 60 * 60 * 1_000),
    ) * 0.25;
  return hits + surfaceBoost + recencyBoost;
}

function isGrantActive(grant: AccessGrant): boolean {
  return grant.revoked !== true;
}

function isRecordAccessible(params: {
  query: RecallQuery;
  record: MemoryRecord;
  grants: AccessGrant[];
}): boolean {
  if (params.record.userId === params.query.userId) {
    return true;
  }
  return params.grants.some(
    (grant) =>
      isGrantActive(grant) &&
      grant.tenantId === params.query.tenantId &&
      grant.ownerUserId === params.record.userId &&
      grant.targetUserId === params.query.userId &&
      grant.surfaces.includes(params.record.surface) &&
      (!grant.appIds || grant.appIds.length === 0 || grant.appIds.includes(params.query.appId)),
  );
}

function normalizeRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    tags: [...record.tags],
    artifacts: [...record.artifacts],
  };
}

function sortRecords(records: MemoryRecord[]): MemoryRecord[] {
  return [...records].toSorted((left, right) => {
    const scoreDiff = (right.score ?? 0) - (left.score ?? 0);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

export class InMemoryTenantBridgeStore implements TenantBridgeStore {
  protected state: TenantBridgeState = {
    records: [],
    grants: [],
  };

  async getRecordByIdempotency(params: {
    tenantId: string;
    idempotencyKey: string;
  }): Promise<MemoryRecord | null> {
    const match = this.state.records.find(
      (record) =>
        record.tenantId === params.tenantId && record.idempotencyKey === params.idempotencyKey,
    );
    return match ? normalizeRecord(match) : null;
  }

  async saveRecord(record: MemoryRecord): Promise<MemoryRecord> {
    const existingIndex = this.state.records.findIndex(
      (entry) => entry.recordId === record.recordId,
    );
    if (existingIndex >= 0) {
      this.state.records[existingIndex] = normalizeRecord(record);
    } else {
      this.state.records.push(normalizeRecord(record));
    }
    return normalizeRecord(record);
  }

  async retrieve(query: RecallQuery): Promise<RecallResult> {
    const surfaces = query.surfaces?.length ? new Set(query.surfaces) : undefined;
    const filtered = this.state.records.filter((record) => {
      if (record.tenantId !== query.tenantId) {
        return false;
      }
      if (surfaces && !surfaces.has(record.surface)) {
        return false;
      }
      if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
        return false;
      }
      if (query.tags?.length && !query.tags.every((tag) => record.tags.includes(tag))) {
        return false;
      }
      return isRecordAccessible({
        query,
        record,
        grants: this.state.grants,
      });
    });

    const scored = filtered
      .map((record) => ({
        ...record,
        score: scoreRecord({ query: query.query, record }),
      }))
      .filter((record) => record.score > 0 || !query.query.trim());

    const limit = Math.max(1, query.limit ?? 8);
    return {
      tenantId: query.tenantId,
      userId: query.userId,
      appId: query.appId,
      query: query.query,
      results: sortRecords(scored).slice(0, limit).map(normalizeRecord),
    };
  }

  async upsertAccessGrant(grant: AccessGrant): Promise<AccessGrant> {
    const nextGrant = {
      ...grant,
      grantId: grant.grantId || randomUUID(),
      surfaces: [...grant.surfaces],
      appIds: grant.appIds ? [...grant.appIds] : undefined,
    };
    const index = this.state.grants.findIndex((entry) => entry.grantId === nextGrant.grantId);
    if (index >= 0) {
      this.state.grants[index] = nextGrant;
    } else {
      this.state.grants.push(nextGrant);
    }
    return { ...nextGrant };
  }

  async promoteRecords(params: {
    tenantId: string;
    userId: string;
    recordIds: string[];
    surface?: RecallSurface;
  }): Promise<MemoryRecord[]> {
    const promoted: MemoryRecord[] = [];
    const targetSurface = params.surface ?? "durable";
    for (const record of this.state.records) {
      if (
        record.tenantId === params.tenantId &&
        record.userId === params.userId &&
        params.recordIds.includes(record.recordId)
      ) {
        record.surface = targetSurface;
        record.updatedAt = new Date().toISOString();
        record.expiresAt = undefined;
        promoted.push(normalizeRecord(record));
      }
    }
    return promoted;
  }

  async listRecords(params: {
    tenantId: string;
    userId?: string;
    surfaces?: RecallSurface[];
  }): Promise<MemoryRecord[]> {
    const surfaces = params.surfaces ? new Set(params.surfaces) : undefined;
    return this.state.records
      .filter(
        (record) =>
          record.tenantId === params.tenantId &&
          (params.userId === undefined || record.userId === params.userId) &&
          (!surfaces || surfaces.has(record.surface)),
      )
      .map(normalizeRecord);
  }

  async cleanup(params: { now: Date }): Promise<CleanupResult> {
    const deletedRecordIds: string[] = [];
    const cutoffMs = params.now.getTime();
    this.state.records = this.state.records.filter((record) => {
      if (record.expiresAt && Date.parse(record.expiresAt) <= cutoffMs) {
        deletedRecordIds.push(record.recordId);
        return false;
      }
      return true;
    });
    return { deletedRecordIds };
  }

  async close(): Promise<void> {}
}

export class FileTenantBridgeStore extends InMemoryTenantBridgeStore {
  private loaded = false;

  constructor(private readonly filePath: string) {
    super();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as TenantBridgeState;
      this.state = {
        records: Array.isArray(parsed.records) ? parsed.records.map(normalizeRecord) : [],
        grants: Array.isArray(parsed.grants)
          ? parsed.grants.map((grant) => ({
              ...grant,
              surfaces: [...grant.surfaces],
              appIds: grant.appIds ? [...grant.appIds] : undefined,
            }))
          : [],
      };
    } catch {
      this.state = { records: [], grants: [] };
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  override async getRecordByIdempotency(params: {
    tenantId: string;
    idempotencyKey: string;
  }): Promise<MemoryRecord | null> {
    await this.ensureLoaded();
    return await super.getRecordByIdempotency(params);
  }

  override async saveRecord(record: MemoryRecord): Promise<MemoryRecord> {
    await this.ensureLoaded();
    const saved = await super.saveRecord(record);
    await this.persist();
    return saved;
  }

  override async retrieve(query: RecallQuery): Promise<RecallResult> {
    await this.ensureLoaded();
    return await super.retrieve(query);
  }

  override async upsertAccessGrant(grant: AccessGrant): Promise<AccessGrant> {
    await this.ensureLoaded();
    const saved = await super.upsertAccessGrant(grant);
    await this.persist();
    return saved;
  }

  override async promoteRecords(params: {
    tenantId: string;
    userId: string;
    recordIds: string[];
    surface?: RecallSurface;
  }): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    const promoted = await super.promoteRecords(params);
    await this.persist();
    return promoted;
  }

  override async listRecords(params: {
    tenantId: string;
    userId?: string;
    surfaces?: RecallSurface[];
  }): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    return await super.listRecords(params);
  }

  override async cleanup(params: { now: Date }): Promise<CleanupResult> {
    await this.ensureLoaded();
    const result = await super.cleanup(params);
    await this.persist();
    return result;
  }
}

type PostgresPoolLike = {
  query: (
    text: string,
    params?: readonly unknown[],
  ) => Promise<{
    rows: Record<string, unknown>[];
  }>;
  end?: () => Promise<void>;
};

function toJsonArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toIsoTimestamp(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || value instanceof Date) {
    return new Date(value).toISOString();
  }
  return new Date(0).toISOString();
}

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    recordId: String(row.record_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    appId: String(row.app_id),
    sessionId: String(row.session_id),
    source: typeof row.source === "string" ? row.source : undefined,
    kind: String(row.kind) as ContextDelta["kind"],
    surface: String(row.surface) as RecallSurface,
    content: String(row.content),
    tags: toJsonArray(row.tags),
    idempotencyKey: String(row.idempotency_key),
    artifacts: Array.isArray(row.artifacts) ? (row.artifacts as MemoryRecord["artifacts"]) : [],
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
    expiresAt: row.expires_at ? toIsoTimestamp(row.expires_at) : undefined,
  };
}

function rowToGrant(row: Record<string, unknown>): AccessGrant {
  return {
    grantId: String(row.grant_id),
    tenantId: String(row.tenant_id),
    ownerUserId: String(row.owner_user_id),
    targetUserId: String(row.target_user_id),
    surfaces: toJsonArray(row.surfaces) as RecallSurface[],
    appIds: toJsonArray(row.app_ids),
    revoked: row.revoked === true,
    note: typeof row.note === "string" ? row.note : undefined,
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

export class PostgresTenantBridgeStore implements TenantBridgeStore {
  private tablesEnsured = false;

  constructor(private readonly pool: PostgresPoolLike) {}

  private async ensureTables(): Promise<void> {
    if (this.tablesEnsured) {
      return;
    }
    this.tablesEnsured = true;
    await this.pool.query(`
      create table if not exists tenant_bridge_records (
        record_id text primary key,
        tenant_id text not null,
        user_id text not null,
        app_id text not null,
        session_id text not null,
        source text,
        kind text not null,
        surface text not null,
        content text not null,
        tags jsonb not null default '[]'::jsonb,
        artifacts jsonb not null default '[]'::jsonb,
        idempotency_key text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        expires_at timestamptz,
        unique (tenant_id, idempotency_key)
      );
    `);
    await this.pool.query(`
      create table if not exists tenant_bridge_access_grants (
        grant_id text primary key,
        tenant_id text not null,
        owner_user_id text not null,
        target_user_id text not null,
        surfaces jsonb not null default '[]'::jsonb,
        app_ids jsonb not null default '[]'::jsonb,
        revoked boolean not null default false,
        note text,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
    `);
  }

  async getRecordByIdempotency(params: {
    tenantId: string;
    idempotencyKey: string;
  }): Promise<MemoryRecord | null> {
    await this.ensureTables();
    const result = await this.pool.query(
      `select * from tenant_bridge_records where tenant_id = $1 and idempotency_key = $2 limit 1`,
      [params.tenantId, params.idempotencyKey],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : null;
  }

  async saveRecord(record: MemoryRecord): Promise<MemoryRecord> {
    await this.ensureTables();
    await this.pool.query(
      `
        insert into tenant_bridge_records (
          record_id, tenant_id, user_id, app_id, session_id, source, kind, surface,
          content, tags, artifacts, idempotency_key, created_at, updated_at, expires_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10::jsonb, $11::jsonb, $12, $13::timestamptz, $14::timestamptz, $15::timestamptz
        )
        on conflict (record_id) do update set
          source = excluded.source,
          kind = excluded.kind,
          surface = excluded.surface,
          content = excluded.content,
          tags = excluded.tags,
          artifacts = excluded.artifacts,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `,
      [
        record.recordId,
        record.tenantId,
        record.userId,
        record.appId,
        record.sessionId,
        record.source ?? null,
        record.kind,
        record.surface,
        record.content,
        JSON.stringify(record.tags),
        JSON.stringify(record.artifacts),
        record.idempotencyKey,
        record.createdAt,
        record.updatedAt,
        record.expiresAt ?? null,
      ],
    );
    return record;
  }

  async retrieve(query: RecallQuery): Promise<RecallResult> {
    await this.ensureTables();
    const recordRows = await this.pool.query(
      `
        select * from tenant_bridge_records
        where tenant_id = $1
          and ($2::text[] is null or surface = any($2::text[]))
          and (expires_at is null or expires_at > now())
        order by updated_at desc
        limit 250
      `,
      [query.tenantId, query.surfaces?.length ? query.surfaces : null],
    );
    const grantRows = await this.pool.query(
      `select * from tenant_bridge_access_grants where tenant_id = $1`,
      [query.tenantId],
    );
    const grants = grantRows.rows.map(rowToGrant);
    const scored = recordRows.rows
      .map(rowToRecord)
      .filter((record) =>
        isRecordAccessible({
          query,
          record,
          grants,
        }),
      )
      .filter(
        (record) => !query.tags?.length || query.tags.every((tag) => record.tags.includes(tag)),
      )
      .map((record) => ({
        ...record,
        score: scoreRecord({ query: query.query, record }),
      }))
      .filter((record) => record.score > 0 || !query.query.trim());
    return {
      tenantId: query.tenantId,
      userId: query.userId,
      appId: query.appId,
      query: query.query,
      results: sortRecords(scored).slice(0, Math.max(1, query.limit ?? 8)),
    };
  }

  async upsertAccessGrant(grant: AccessGrant): Promise<AccessGrant> {
    await this.ensureTables();
    const nextGrant: AccessGrant = {
      ...grant,
      grantId: grant.grantId || randomUUID(),
      updatedAt: grant.updatedAt || new Date().toISOString(),
      createdAt: grant.createdAt || new Date().toISOString(),
    };
    await this.pool.query(
      `
        insert into tenant_bridge_access_grants (
          grant_id, tenant_id, owner_user_id, target_user_id,
          surfaces, app_ids, revoked, note, created_at, updated_at
        ) values (
          $1, $2, $3, $4,
          $5::jsonb, $6::jsonb, $7, $8, $9::timestamptz, $10::timestamptz
        )
        on conflict (grant_id) do update set
          surfaces = excluded.surfaces,
          app_ids = excluded.app_ids,
          revoked = excluded.revoked,
          note = excluded.note,
          updated_at = excluded.updated_at
      `,
      [
        nextGrant.grantId,
        nextGrant.tenantId,
        nextGrant.ownerUserId,
        nextGrant.targetUserId,
        JSON.stringify(nextGrant.surfaces),
        JSON.stringify(nextGrant.appIds ?? []),
        nextGrant.revoked === true,
        nextGrant.note ?? null,
        nextGrant.createdAt,
        nextGrant.updatedAt,
      ],
    );
    return nextGrant;
  }

  async promoteRecords(params: {
    tenantId: string;
    userId: string;
    recordIds: string[];
    surface?: RecallSurface;
  }): Promise<MemoryRecord[]> {
    await this.ensureTables();
    const surface = params.surface ?? "durable";
    const result = await this.pool.query(
      `
        update tenant_bridge_records
        set surface = $4, updated_at = now(), expires_at = null
        where tenant_id = $1 and user_id = $2 and record_id = any($3::text[])
        returning *
      `,
      [params.tenantId, params.userId, params.recordIds, surface],
    );
    return result.rows.map(rowToRecord);
  }

  async listRecords(params: {
    tenantId: string;
    userId?: string;
    surfaces?: RecallSurface[];
  }): Promise<MemoryRecord[]> {
    await this.ensureTables();
    const result = await this.pool.query(
      `
        select * from tenant_bridge_records
        where tenant_id = $1
          and ($2::text is null or user_id = $2)
          and ($3::text[] is null or surface = any($3::text[]))
          and (expires_at is null or expires_at > now())
        order by updated_at desc
      `,
      [params.tenantId, params.userId ?? null, params.surfaces?.length ? params.surfaces : null],
    );
    return result.rows.map(rowToRecord);
  }

  async cleanup(params: { now: Date }): Promise<CleanupResult> {
    await this.ensureTables();
    const result = await this.pool.query(
      `
        delete from tenant_bridge_records
        where expires_at is not null and expires_at <= $1::timestamptz
        returning record_id
      `,
      [params.now.toISOString()],
    );
    return {
      deletedRecordIds: result.rows.map((row) => String(row.record_id)),
    };
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }
}
