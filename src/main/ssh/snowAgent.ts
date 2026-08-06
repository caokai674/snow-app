import { verify } from "node:crypto";
import { executeSshCommand, type SshCapabilities } from "./sshManager";
import { runWindowsPowerShell } from "./windowsRemoteRunner";

export const SNOW_AGENT_PROTOCOL_VERSION = 1;

export type SnowAgentCapabilities = {
  transactionalQueue: boolean;
  processGroups: boolean;
  resourceLimits: boolean;
  outputFrames: boolean;
  fileCas: boolean;
  interactiveAttach: boolean;
};

export type SnowAgentHandshake = {
  protocolVersion: number;
  version: string;
  artifactSha256: string;
  release: {
    keyId: string;
    payload: string;
    signature: string;
  };
  capabilities: SnowAgentCapabilities;
};

type SnowAgentReleasePayload = {
  protocolVersion: number;
  version: string;
  artifactSha256: string;
  capabilities: SnowAgentCapabilities;
};

const requiredCapabilities = (capabilities: SnowAgentCapabilities): boolean =>
  capabilities.transactionalQueue &&
  capabilities.processGroups &&
  capabilities.resourceLimits &&
  capabilities.outputFrames &&
  capabilities.fileCas;

const sameCapabilities = (
  left: SnowAgentCapabilities,
  right: SnowAgentCapabilities
): boolean =>
  left.transactionalQueue === right.transactionalQueue &&
  left.processGroups === right.processGroups &&
  left.resourceLimits === right.resourceLimits &&
  left.outputFrames === right.outputFrames &&
  left.fileCas === right.fileCas &&
  left.interactiveAttach === right.interactiveAttach;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseCapabilities = (value: unknown): SnowAgentCapabilities | null => {
  if (!isRecord(value)) {
    return null;
  }
  const names = [
    "transactionalQueue",
    "processGroups",
    "resourceLimits",
    "outputFrames",
    "fileCas",
    "interactiveAttach",
  ] as const;
  if (!names.every((name) => typeof value[name] === "boolean")) {
    return null;
  }
  return {
    transactionalQueue: value.transactionalQueue as boolean,
    processGroups: value.processGroups as boolean,
    resourceLimits: value.resourceLimits as boolean,
    outputFrames: value.outputFrames as boolean,
    fileCas: value.fileCas as boolean,
    interactiveAttach: value.interactiveAttach as boolean,
  };
};

export const parseSnowAgentHandshake = (value: unknown): SnowAgentHandshake => {
  if (!isRecord(value) || typeof value.protocolVersion !== "number") {
    throw new Error("snow-agent handshake is malformed");
  }
  if (value.protocolVersion !== SNOW_AGENT_PROTOCOL_VERSION) {
    throw new Error(
      `snow-agent protocol ${value.protocolVersion} is incompatible with ${SNOW_AGENT_PROTOCOL_VERSION}`
    );
  }
  if (typeof value.version !== "string" || !value.version.trim()) {
    throw new Error("snow-agent handshake has no version");
  }
  if (
    typeof value.artifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.artifactSha256)
  ) {
    throw new Error("snow-agent handshake has an invalid artifact hash");
  }
  if (!isRecord(value.release)) {
    throw new Error("snow-agent handshake has no signed release declaration");
  }
  const { keyId, payload, signature } = value.release;
  if (
    typeof keyId !== "string" ||
    !keyId ||
    typeof payload !== "string" ||
    !payload ||
    typeof signature !== "string" ||
    !signature
  ) {
    throw new Error("snow-agent release declaration is malformed");
  }
  const capabilities = parseCapabilities(value.capabilities);
  if (!capabilities || !requiredCapabilities(capabilities)) {
    throw new Error("snow-agent is missing required durable-job capabilities");
  }
  return {
    protocolVersion: value.protocolVersion,
    version: value.version,
    artifactSha256: value.artifactSha256.toLowerCase(),
    release: { keyId, payload, signature },
    capabilities,
  };
};

/**
 * The release key is deliberately supplied by the signed application build,
 * rather than accepted from the remote host. Development builds can provide
 * it through the environment; production packaging injects the same value at
 * build time. Without a key, snow-agent remains unavailable.
 */
const trustedReleasePublicKey = (): string | null => {
  const key = process.env.SNOW_AGENT_RELEASE_PUBLIC_KEY?.trim();
  return key || null;
};

export const verifySnowAgentHandshake = (
  handshake: SnowAgentHandshake,
  publicKey = trustedReleasePublicKey()
): void => {
  if (!publicKey) {
    throw new Error("snow-agent release public key is not configured");
  }
  let payload: SnowAgentReleasePayload;
  try {
    payload = JSON.parse(handshake.release.payload) as SnowAgentReleasePayload;
  } catch {
    throw new Error("snow-agent signed release payload is invalid JSON");
  }
  if (
    payload.protocolVersion !== handshake.protocolVersion ||
    payload.version !== handshake.version ||
    payload.artifactSha256.toLowerCase() !== handshake.artifactSha256 ||
    !sameCapabilities(payload.capabilities, handshake.capabilities)
  ) {
    throw new Error("snow-agent signed release payload does not match the handshake");
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(handshake.release.signature, "base64");
  } catch {
    throw new Error("snow-agent release signature is not base64");
  }
  if (
    signature.length === 0 ||
    !verify(null, Buffer.from(handshake.release.payload, "utf8"), publicKey, signature)
  ) {
    throw new Error("snow-agent release signature verification failed");
  }
};

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `"'"'`)}'`;

const powerShellLiteral = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

const runSnowAgent = async (
  sessionId: string,
  capabilities: SshCapabilities,
  args: string[],
  timeoutMs = 15_000,
  signal?: AbortSignal
): Promise<string> => {
  if (capabilities.platform === "windows") {
    return runWindowsPowerShell(
      sessionId,
      `& snow-agent.exe @(${args.map(powerShellLiteral).join(",")})`,
      timeoutMs,
      signal
    );
  }
  return executeSshCommand(
    sessionId,
    `snow-agent ${args.map(shellQuote).join(" ")}`,
    { timeoutMs, signal }
  );
};

const parseJsonResult = (output: string, action: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!isRecord(parsed)) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error(`snow-agent ${action} did not return a JSON object`);
  }
};

const verifiedAgents = new Map<string, SnowAgentHandshake>();

const agentCacheKey = (sessionId: string): string => sessionId;

export const negotiateSnowAgent = async (
  sessionId: string,
  capabilities: SshCapabilities
): Promise<SnowAgentHandshake> => {
  const cacheKey = agentCacheKey(sessionId);
  const cached = verifiedAgents.get(cacheKey);
  if (cached) {
    return cached;
  }
  const output = await runSnowAgent(
    sessionId,
    capabilities,
    ["protocol", "--format=json"],
    10_000
  );
  const handshake = parseSnowAgentHandshake(parseJsonResult(output, "protocol"));
  verifySnowAgentHandshake(handshake);
  verifiedAgents.set(cacheKey, handshake);
  return handshake;
};

export const launchSnowAgentJob = async (
  sessionId: string,
  capabilities: SshCapabilities,
  jobDirectory: string,
  jobId: string,
  signal?: AbortSignal
): Promise<void> => {
  const receipt = parseJsonResult(
    await runSnowAgent(
      sessionId,
      capabilities,
      ["job", "launch", "--job-directory", jobDirectory],
      15_000,
      signal
    ),
    "job launch"
  );
  if (receipt.accepted !== true || receipt.jobId !== jobId) {
    throw new Error("snow-agent rejected the Remote Job launch");
  }
};

export const probeSnowAgentLiveness = async (
  sessionId: string,
  capabilities: SshCapabilities
): Promise<void> => {
  const result = parseJsonResult(
    await runSnowAgent(
      sessionId,
      capabilities,
      ["job", "self-test", "--disconnect-survival"],
      15_000
    ),
    "job self-test"
  );
  if (result.disconnectSurvival !== true) {
    throw new Error("snow-agent did not pass disconnect-survival self-test");
  }
};

export const inspectSnowAgentJob = async (
  sessionId: string,
  capabilities: SshCapabilities,
  jobDirectory: string
): Promise<"active" | "inactive"> => {
  const result = parseJsonResult(
    await runSnowAgent(
      sessionId,
      capabilities,
      ["job", "inspect", "--job-directory", jobDirectory]
    ),
    "job inspect"
  );
  return result.active === true ? "active" : "inactive";
};

export const cancelSnowAgentJob = async (
  sessionId: string,
  capabilities: SshCapabilities,
  jobDirectory: string
): Promise<void> => {
  const result = parseJsonResult(
    await runSnowAgent(
      sessionId,
      capabilities,
      ["job", "cancel", "--job-directory", jobDirectory]
    ),
    "job cancel"
  );
  if (result.accepted !== true) {
    throw new Error("snow-agent did not accept the Remote Job cancellation");
  }
};

export const clearSnowAgentHandshakeCacheForTesting = (): void => {
  verifiedAgents.clear();
};
