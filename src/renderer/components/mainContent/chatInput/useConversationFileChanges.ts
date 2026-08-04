import { useEffect, useMemo, useState } from "react";
import type {
  ChatConversationMessage,
  FileChangeRecord,
} from "../chatMessages/utils/conversationTypes";

type UseConversationFileChangesParams = {
  baselineCheckpointId?: string;
  workDir?: string;
  messages: ChatConversationMessage[];
  conversationVersion: number;
  fallbackChanges: FileChangeRecord[];
};

type CheckpointDiffs = Awaited<
  ReturnType<typeof window.snow.listCheckpointDiffs>
>;

type CheckpointDiffState = {
  requestKey: string;
  diffs: CheckpointDiffs | null;
};

const normalizePath = (filePath: string): string =>
  filePath.replaceAll("\\", "/").replace(/^\.\/+/, "").toLowerCase();

const findFallbackChange = (
  checkpointPath: string,
  fallbackChanges: FileChangeRecord[]
): FileChangeRecord | undefined => {
  const normalizedCheckpointPath = normalizePath(checkpointPath);
  return fallbackChanges.find((change) => {
    const normalizedToolPath = normalizePath(change.filePath);
    return (
      normalizedToolPath === normalizedCheckpointPath ||
      normalizedToolPath.endsWith(`/${normalizedCheckpointPath}`)
    );
  });
};

const toFileChangeKind = (
  changeType: string
): FileChangeRecord["kind"] => {
  if (changeType === "added") {
    return "create";
  }
  if (changeType === "deleted") {
    return "delete";
  }
  return "edit";
};

/**
 * Returns the conversation's final net workspace diff from its first local
 * checkpoint. Remote workspaces and unavailable checkpoint APIs retain the
 * tool-recorded approximation so SSH statistics continue to work.
 */
export const useConversationFileChanges = ({
  baselineCheckpointId,
  workDir,
  messages,
  conversationVersion,
  fallbackChanges,
}: UseConversationFileChangesParams): FileChangeRecord[] => {
  const completedToolSignature = useMemo(
    () =>
      messages
        .flatMap((message) => message.toolCalls ?? [])
        .filter((toolCall) => toolCall.status === "completed")
        .map(
          (toolCall) =>
            `${toolCall.interactionId}:${toolCall.status}:${toolCall.result?.length ?? 0}`
        )
        .join("|"),
    [messages]
  );

  const canUseCheckpoint = Boolean(
    baselineCheckpointId && workDir && !workDir.startsWith("ssh://")
  );
  const requestKey = JSON.stringify([
    baselineCheckpointId ?? "",
    workDir ?? "",
    completedToolSignature,
    conversationVersion,
  ]);
  const [checkpointState, setCheckpointState] =
    useState<CheckpointDiffState>({ requestKey: "", diffs: null });

  useEffect(() => {
    if (!canUseCheckpoint || !baselineCheckpointId || !workDir) {
      return;
    }

    let cancelled = false;
    void window.snow
      .listCheckpointDiffs(baselineCheckpointId, workDir)
      .then((diffs) => {
        if (!cancelled) {
          setCheckpointState({ requestKey, diffs });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCheckpointState({ requestKey, diffs: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    baselineCheckpointId,
    canUseCheckpoint,
    completedToolSignature,
    conversationVersion,
    requestKey,
    workDir,
  ]);

  return useMemo(() => {
    if (
      !canUseCheckpoint ||
      checkpointState.requestKey !== requestKey ||
      checkpointState.diffs === null
    ) {
      return fallbackChanges;
    }

    return checkpointState.diffs.map((diff, index) => {
      const fallback = findFallbackChange(diff.path, fallbackChanges);
      return {
        filePath: diff.path,
        kind: toFileChangeKind(diff.changeType),
        agent: fallback?.agent ?? "main",
        subAgentName: fallback?.subAgentName,
        timestamp: fallback?.timestamp ?? index,
        diff: {
          patch: diff.content,
          isBinary: diff.isBinary,
        },
      };
    });
  }, [
    canUseCheckpoint,
    checkpointState,
    fallbackChanges,
    requestKey,
  ]);
};
