export type RecallSurface = "episodic" | "durable" | "artifact";

export type ContextDeltaKind = "message" | "decision" | "task" | "fact" | "summary" | "artifact";

export type ArtifactInput = {
  artifactId?: string;
  name?: string;
  contentType?: string;
  contentText?: string;
  contentBase64?: string;
  url?: string;
  metadata?: Record<string, unknown>;
};

export type StoredArtifact = {
  artifactId: string;
  name?: string;
  contentType?: string;
  storageUrl?: string;
  url?: string;
  metadata?: Record<string, unknown>;
};

export type ContextDelta = {
  tenantId: string;
  userId: string;
  appId: string;
  sessionId: string;
  source?: string;
  timestamp: string;
  kind: ContextDeltaKind;
  content: string;
  artifacts?: ArtifactInput[];
  tags?: string[];
  idempotencyKey: string;
};

export type MemoryRecord = {
  recordId: string;
  tenantId: string;
  userId: string;
  appId: string;
  sessionId: string;
  source?: string;
  kind: ContextDeltaKind;
  surface: RecallSurface;
  content: string;
  tags: string[];
  idempotencyKey: string;
  artifacts: StoredArtifact[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  score?: number;
};

export type AccessGrant = {
  grantId: string;
  tenantId: string;
  ownerUserId: string;
  targetUserId: string;
  surfaces: RecallSurface[];
  appIds?: string[];
  revoked?: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type RecallQuery = {
  tenantId: string;
  userId: string;
  appId: string;
  sessionId?: string;
  query: string;
  surfaces?: RecallSurface[];
  limit?: number;
  tags?: string[];
};

export type RecallResult = {
  tenantId: string;
  userId: string;
  appId: string;
  query: string;
  results: MemoryRecord[];
};

export type PromotionRequest = {
  tenantId: string;
  userId: string;
  appId: string;
  recordIds: string[];
};

export type TenantBridgeState = {
  records: MemoryRecord[];
  grants: AccessGrant[];
};
