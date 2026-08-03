import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import type {
  ImportCandidate,
  ImportCandidateOrigin,
  ImportCandidateResult,
  ImportCandidateStatus,
  ImportCandidateType,
  ImportDiscovery,
  ImportOwnership,
  ImportProvider,
  ImportScope,
  ImportSource,
} from "../../shared/importDiscovery";

export type ImportCandidateInput = {
  type: ImportCandidateType;
  provider: ImportProvider;
  scope: ImportScope;
  originPath: string;
  logicalId: string;
  contentHash: string;
  projectId?: string;
  projectRoot?: string;
  unsupportedReason?: string;
};

export type ImportSourceDiscovery = {
  source: ImportSource;
  candidates: ImportCandidateInput[];
};

const ignoredDirectoryNames = new Set([".git", "node_modules", "sessions"]);

const canonicalPath = (path: string): string => {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};

const stableValue = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableValue).join(",")}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
};

export const hashImportValue = (value: unknown): string =>
  createHash("sha256").update(stableValue(value)).digest("hex");

export const hashImportPath = (path: string): string => {
  const hasher = createHash("sha256");
  const root = canonicalPath(path);
  if (!existsSync(root)) {
    return hashImportValue({ missing: root });
  }

  const visit = (current: string): void => {
    const metadata = statSync(current);
    if (metadata.isFile()) {
      hasher.update(relative(root, current));
      hasher.update(readFileSync(current));
      return;
    }
    if (!metadata.isDirectory()) {
      return;
    }
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) {
        hasher.update(`symlink:${entry.name}`);
        continue;
      }
      if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) {
        continue;
      }
      visit(join(current, entry.name));
    }
  };

  visit(root);
  return hasher.digest("hex");
};

export const normalizeLogicalId = (value: string): string =>
  value.trim().replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();

const isWithin = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}${sep}`);

const isAlreadyEffectiveSkill = (input: ImportCandidateInput, originPath: string): boolean => {
  if (input.type !== "skill") {
    return false;
  }
  const globalRoot = canonicalPath(join(homedir(), ".agents", "skills"));
  if (input.scope === "global") {
    return isWithin(originPath, globalRoot);
  }
  return Boolean(
    input.projectRoot &&
    isWithin(originPath, canonicalPath(join(input.projectRoot, ".agents", "skills")))
  );
};

const statusFor = (input: ImportCandidateInput, originPath: string): ImportCandidateStatus => {
  if (input.unsupportedReason) {
    return "unsupported";
  }
  return isAlreadyEffectiveSkill(input, originPath) ? "already-effective" : "new";
};

const ownershipFor = (sourceCount: number): ImportOwnership => ({
  owner: sourceCount > 1 ? "shared" : "external",
  management: "reference",
});

const originFor = (input: ImportCandidateInput, originPath: string): ImportCandidateOrigin => ({
  provider: input.provider,
  scope: input.scope,
  originPath,
  ...(input.projectId ? { projectId: input.projectId } : {}),
});

const sameResource = (left: ImportCandidateInput & { canonicalOriginPath: string }, right: ImportCandidateInput & { canonicalOriginPath: string }): boolean =>
  left.type === right.type && (
    left.contentHash === right.contentHash ||
    (left.logicalId === right.logicalId && left.canonicalOriginPath === right.canonicalOriginPath)
  );

const resultFor = (candidate: ImportCandidate): ImportCandidateResult => {
  if (candidate.status === "already-effective") {
    return {
      candidateId: candidate.candidateId,
      status: "already-effective",
      copyRequired: false,
      sourceCount: candidate.sources.length,
      reason: "Snow already scans this external Skill path",
    };
  }
  if (candidate.status === "conflict") {
    return {
      candidateId: candidate.candidateId,
      status: "conflict",
      copyRequired: false,
      sourceCount: candidate.sources.length,
      reason: "Sources use the same logical ID with different content",
    };
  }
  if (candidate.status === "unsupported") {
    return {
      candidateId: candidate.candidateId,
      status: "unsupported",
      copyRequired: false,
      sourceCount: candidate.sources.length,
      reason: candidate.unsupportedReason,
    };
  }
  return {
    candidateId: candidate.candidateId,
    status: candidate.sources.length > 1 ? "deduplicated" : "discovered",
    copyRequired: false,
    sourceCount: candidate.sources.length,
  };
};

export const buildImportDiscovery = (discoveries: ImportSourceDiscovery[]): ImportDiscovery => {
  const inputs = discoveries
    .flatMap((discovery) => discovery.candidates)
    .map((candidate) => ({
      ...candidate,
      logicalId: normalizeLogicalId(candidate.logicalId),
      canonicalOriginPath: canonicalPath(candidate.originPath),
    }));
  const groups: Array<typeof inputs> = [];

  for (const input of inputs) {
    const matching = groups.find((group) => group.some((existing) => sameResource(existing, input)));
    if (matching) {
      matching.push(input);
    } else {
      groups.push([input]);
    }
  }

  const candidates = groups.map((group) => {
    const primary = group[0];
    const sources = group
      .map((input) => originFor(input, input.canonicalOriginPath))
      .filter((source, index, all) =>
        all.findIndex((candidate) =>
          candidate.provider === source.provider &&
          candidate.scope === source.scope &&
          candidate.originPath === source.originPath &&
          candidate.projectId === source.projectId
        ) === index
      );
    const candidateId = `${primary.type}:${hashImportValue({
      logicalId: primary.logicalId,
      contentHash: primary.contentHash,
      originPaths: sources.map((source) => source.originPath).sort(),
    }).slice(0, 24)}`;
    const status = group.some((input) => statusFor(input, input.canonicalOriginPath) === "unsupported")
      ? "unsupported"
      : group.some((input) => statusFor(input, input.canonicalOriginPath) === "already-effective")
        ? "already-effective"
        : "new";
    return {
      candidateId,
      type: primary.type,
      provider: primary.provider,
      scope: primary.scope,
      originPath: primary.canonicalOriginPath,
      logicalId: primary.logicalId,
      contentHash: primary.contentHash,
      status,
      ownership: ownershipFor(sources.length),
      sources,
      ...(group.find((input) => input.unsupportedReason)?.unsupportedReason
        ? { unsupportedReason: group.find((input) => input.unsupportedReason)?.unsupportedReason }
        : {}),
    } satisfies ImportCandidate;
  });

  const conflicts = new Set(
    candidates
      .filter((candidate) => candidates.some((other) =>
        other.candidateId !== candidate.candidateId &&
        other.type === candidate.type &&
        other.logicalId === candidate.logicalId &&
        other.contentHash !== candidate.contentHash
      ))
      .map((candidate) => candidate.candidateId)
  );
  for (const candidate of candidates) {
    if (conflicts.has(candidate.candidateId)) {
      candidate.status = "conflict";
    }
  }

  return {
    sources: discoveries.map((discovery) => discovery.source),
    candidates,
    results: candidates.map(resultFor),
    warnings: discoveries.flatMap((discovery) => discovery.source.warnings),
  };
};

export const skillLogicalId = (skillDir: string): string => normalizeLogicalId(basename(skillDir));
