export type PackageKind = "profile" | "target" | "legacy_unassigned";
export type PackageState = "active" | "trashed" | "purge_pending" | "purged";
export type Scope = { packageId: string; targetRevisionId: string };
export type ReadScope = Scope | { allTargets: true };
export type Counts = {
  profiles: number;
  targets: number;
  jobs: number;
  observations: number;
  evaluations: number;
  runs: number;
  applications: number;
  events: number;
  files: number;
};
export type Package = {
  packageId: string;
  kind: PackageKind;
  versionId: string;
  versionName: string;
  enabled: boolean;
  state: PackageState;
  archiveId: string | null;
  archivedAt: string | null;
  purgeAt: string | null;
};
export type Preview = {
  workspaceRevision: number;
  planHash: string;
  candidates: {
    packageId: string;
    archiveId: string;
    purgeAt: string;
    counts: Counts;
  }[];
  totals: Counts;
  packageCount: number;
};
export type PurgeResult = {
  completed: string[];
  pending: string[];
  failed: { operationId: string; code: string }[];
};
export type ProfileVersion = {
  profileId: string;
  revisionId: string;
  packageId: string;
  versionName: string;
  enabled: boolean;
  archivedAt?: string | null;
  state?: PackageState;
  text?: string;
  profile: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  parserVersion?: string;
};
export type TargetVersion = {
  targetId: string;
  revisionId: string;
  packageId: string;
  versionName: string;
  enabled: boolean;
  archivedAt?: string | null;
  state?: PackageState;
  profileRevisionId?: string;
  profileSnapshot?: {
    revisionId?: string;
    text: string;
    profile: Record<string, unknown>;
    overrides?: Record<string, unknown>;
    parserVersion?: string;
  };
  roles?: string[];
  cities?: string[];
  cityMode?: string;
  sourceIds?: string[];
  siteIds?: string[];
  budgets?: Record<string, unknown>;
  [key: string]: unknown;
};
export type ApiError = Error & {
  code?: string;
  status?: number;
  diagnosticId?: string;
  fieldErrors?: Record<string, string>;
};
export type RequestOptions = {
  method?: string;
  body?: unknown;
  scope?: ReadScope;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};
export type RunEvent = {
  type: string;
  seq?: number;
  payload?: Record<string, unknown>;
};
export interface ApiClient {
  request<T = Record<string, unknown>>(
    path: string,
    options?: RequestOptions,
  ): Promise<T>;
  download(path: string, options?: RequestOptions): Promise<Blob>;
  streamRun(
    runId: string,
    options: {
      scope: Scope;
      signal?: AbortSignal;
      onEvent: (event: RunEvent) => void | Promise<void>;
      afterSeq?: number;
    },
  ): Promise<void>;
}
export interface DesktopBridge {
  isAvailable(): Promise<unknown>;
  getKeyStatus(provider: string): Promise<unknown>;
  saveKey(provider: string, key: string): Promise<unknown>;
  deleteKey(provider: string): Promise<unknown>;
  getDataLocations(): Promise<unknown>;
  openDataLocation(kind: string): Promise<unknown>;
  copyDataLocation(kind: string): Promise<unknown>;
  reportDiagnostic?(event: Record<string, unknown>): Promise<unknown>;
}
export type DesktopAdapter = DesktopBridge & { available: boolean };
