import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  FileContentResult,
  FileSearchResult,
  ParsedSshUrl,
  RemoteJobBinding,
  RemoteJobOutput,
  RemoteJobPtyAttachment,
  RemoteJobStartRequest,
  RemoteWorkspaceFileSearchOptions,
  SshConnectParams,
  SshCapabilities,
  SshCredentialRecord,
  SshDirectoryEntry,
  SshAuthMethod,
  SshFileWriteOptions,
  SshFileWriteResult,
  SshProfileConnection,
  RemoteDraftInput,
  RemoteDraftRecord,
} from "../types";

export const sshApi = {
  sshConnect: (params: SshConnectParams): Promise<string> =>
    ipcRenderer.invoke("ssh:connect", params),
  sshConnectProfile: (params: SshConnectParams): Promise<SshProfileConnection> =>
    ipcRenderer.invoke("ssh:profiles:connect", params),
  sshGetProfileConnection: (
    profileId: string
  ): Promise<SshProfileConnection | null> =>
    ipcRenderer.invoke("ssh:profiles:get", profileId),
  sshReleaseProfile: (profileId: string): Promise<void> =>
    ipcRenderer.invoke("ssh:profiles:release", profileId),
  sshListRemoteDrafts: (
    workspaceId: string,
    profileId?: string
  ): Promise<RemoteDraftRecord[]> =>
    ipcRenderer.invoke("ssh:drafts:list", workspaceId, profileId),
  sshUpsertRemoteDraft: (draft: RemoteDraftInput): Promise<RemoteDraftRecord> =>
    ipcRenderer.invoke("ssh:drafts:upsert", draft),
  sshDeleteRemoteDraft: (
    profileId: string,
    workspaceId: string,
    remotePath: string
  ): Promise<void> =>
    ipcRenderer.invoke("ssh:drafts:delete", profileId, workspaceId, remotePath),
  onSshProfileConnection: (
    callback: (connection: SshProfileConnection) => void
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, connection: SshProfileConnection): void => {
      callback(connection);
    };
    ipcRenderer.on("ssh:profile-state", handler);
    return () => ipcRenderer.removeListener("ssh:profile-state", handler);
  },
  sshListDirectory: (
    sessionId: string,
    remotePath: string
  ): Promise<SshDirectoryEntry[]> =>
    ipcRenderer.invoke("ssh:list-directory", sessionId, remotePath),
  sshExecuteCommand: (sessionId: string, command: string): Promise<string> =>
    ipcRenderer.invoke("ssh:execute-command", sessionId, command),
  sshProbeCapabilities: (sessionId: string): Promise<SshCapabilities> =>
    ipcRenderer.invoke("ssh:probe-capabilities", sessionId),
  searchRemoteWorkspaceFiles: (
    workspacePath: string,
    options: RemoteWorkspaceFileSearchOptions
  ): Promise<FileSearchResult[]> =>
    ipcRenderer.invoke("ssh:search-workspace-files", workspacePath, options),
  sshReadFile: (
    sessionId: string,
    remotePath: string
  ): Promise<FileContentResult> =>
    ipcRenderer.invoke("ssh:read-file", sessionId, remotePath),
  sshWriteFile: (
    sessionId: string,
    remotePath: string,
    content: string,
    options: SshFileWriteOptions
  ): Promise<SshFileWriteResult> =>
    ipcRenderer.invoke("ssh:write-file", sessionId, remotePath, content, options),
  sshDeleteEntry: (sessionId: string, remotePath: string): Promise<void> =>
    ipcRenderer.invoke("ssh:delete-entry", sessionId, remotePath),
  sshRenameEntry: (
    sessionId: string,
    remotePath: string,
    newName: string
  ): Promise<void> =>
    ipcRenderer.invoke("ssh:rename-entry", sessionId, remotePath, newName),
  sshDisconnect: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("ssh:disconnect", sessionId),
  sshSaveCredential: (params: {
    host: string;
    port: number;
    username: string;
    authMethod: SshAuthMethod;
    privateKeyPath?: string;
    secret?: string;
  }): Promise<SshCredentialRecord> =>
    ipcRenderer.invoke("ssh:save-credential", params),
  sshGetCredential: (
    host: string,
    port: number,
    username: string
  ): Promise<SshCredentialRecord | null> =>
    ipcRenderer.invoke("ssh:get-credential", host, port, username),
  sshGetDecryptedSecret: (
    host: string,
    port: number,
    username: string
  ): Promise<string | null> =>
    ipcRenderer.invoke("ssh:get-decrypted-secret", host, port, username),
  sshListCredentials: (): Promise<SshCredentialRecord[]> =>
    ipcRenderer.invoke("ssh:list-credentials"),
  sshDeleteCredential: (
    host: string,
    port: number,
    username: string
  ): Promise<void> =>
    ipcRenderer.invoke("ssh:delete-credential", host, port, username),
  sshSelectPrivateKey: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("ssh:select-private-key", dialogTitle),
  sshParseUrl: (sshUrl: string): Promise<ParsedSshUrl> =>
    ipcRenderer.invoke("ssh:parse-url", sshUrl),
  sshStartRemoteJob: (
    request: RemoteJobStartRequest
  ): Promise<RemoteJobBinding> => ipcRenderer.invoke("ssh:jobs:start", request),
  sshListRemoteJobs: (workspacePath?: string): Promise<RemoteJobBinding[]> =>
    ipcRenderer.invoke("ssh:jobs:list", workspacePath),
  sshGetRemoteJob: (
    jobId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<RemoteJobOutput> =>
    ipcRenderer.invoke("ssh:jobs:get", jobId, options),
  sshCancelRemoteJob: (jobId: string): Promise<RemoteJobBinding> =>
    ipcRenderer.invoke("ssh:jobs:cancel", jobId),
  sshAttachRemoteJob: (
    jobId: string,
    viewport: { cols: number; rows: number }
  ): Promise<RemoteJobPtyAttachment> =>
    ipcRenderer.invoke("ssh:jobs:attach", jobId, viewport),
  sshGetRemoteJobAnalysisContext: (
    jobId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<string> =>
    ipcRenderer.invoke("ssh:jobs:analysis-context", jobId, options),
  sshCleanupRemoteJobs: (): Promise<{ removed: string[] }> =>
    ipcRenderer.invoke("ssh:jobs:cleanup"),
};
