export type ImportCandidateType =
  | "mcp"
  | "skill"
  | "prompt"
  | "command"
  | "agent"
  | "plugin";

export type ImportProvider = "codex" | "claude-code" | "opencode" | "snow";

export type ImportScope = "global" | "project";

export type ImportCandidateStatus =
  | "new"
  | "already-effective"
  | "update-available"
  | "conflict"
  | "unsupported"
  | "managed";

export type ImportOwnership = {
  owner: "external" | "snow" | "shared";
  management: "reference" | "snapshot" | "user-adopted";
};

export type ImportCandidateOrigin = {
  provider: ImportProvider;
  scope: ImportScope;
  originPath: string;
  projectId?: string;
};

export type ImportCandidate = {
  candidateId: string;
  type: ImportCandidateType;
  provider: ImportProvider;
  scope: ImportScope;
  originPath: string;
  logicalId: string;
  contentHash: string;
  status: ImportCandidateStatus;
  ownership: ImportOwnership;
  sources: ImportCandidateOrigin[];
  unsupportedReason?: string;
};

export type ImportCandidateResultStatus =
  | "discovered"
  | "deduplicated"
  | "already-effective"
  | "conflict"
  | "unsupported";

export type ImportCandidateResult = {
  candidateId: string;
  status: ImportCandidateResultStatus;
  copyRequired: false;
  sourceCount: number;
  reason?: string;
};

export type ImportConfigPath = {
  label: string;
  path: string;
  found: boolean;
};

export type ImportSource = {
  provider: ImportProvider;
  sourceHome: string;
  sourceFound: boolean;
  configPaths: ImportConfigPath[];
  instructionPaths: ImportConfigPath[];
  projectConfigCount: number;
  warnings: string[];
};

export type ImportDiscovery = {
  sources: ImportSource[];
  candidates: ImportCandidate[];
  results: ImportCandidateResult[];
  warnings: string[];
};

export type ReadonlyImportResult = ImportDiscovery & {
  applied: false;
};
