import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeBridge } from "../../native/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
const resolveSshWorkspaceRoot = vi.hoisted(() => vi.fn(() => "/workspace"));
const writeSshFile = vi.hoisted(() => vi.fn());
const listWorkspaceDirectories = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

vi.mock("../../ssh/sshManager", () => ({
  connectSsh: vi.fn(),
  deleteSshDirectory: vi.fn(),
  deleteSshFile: vi.fn(),
  disconnectSsh: vi.fn(),
  executeSshCommand: vi.fn(),
  isSshPath: vi.fn(),
  listSshDirectory: vi.fn(),
  parseSshUrl: vi.fn(),
  probeSshCapabilities: vi.fn(),
  readSshFile: vi.fn(),
  readSshFileWithVersion: vi.fn(),
  renameSshFile: vi.fn(),
  resolveSshWorkspaceRoot,
  statSshEntry: vi.fn(),
  writeSshFile,
}));

vi.mock("../../ssh/sshConnectionManager", () => ({
  sshConnectionManager: {
    acquire: vi.fn(),
    get: vi.fn(),
    release: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  },
}));

vi.mock("../../ssh/sshCredentials", () => ({
  deleteSshCredential: vi.fn(),
  getDecryptedSecret: vi.fn(),
  getSshCredential: vi.fn(),
  listSshCredentials: vi.fn(),
  saveSshCredentialWithPlainSecret: vi.fn(),
}));

vi.mock("../../ssh/remoteJobs", () => ({
  cancelRemoteJob: vi.fn(),
  cleanupRemoteJobs: vi.fn(),
  getRemoteJob: vi.fn(),
  getRemoteJobAnalysisContext: vi.fn(),
  getRemoteJobAttachSpec: vi.fn(),
  listRemoteJobs: vi.fn(),
  startRemoteJob: vi.fn(),
}));

vi.mock("../../pty/ptyManager", () => ({
  createRemoteJobPtySession: vi.fn(),
}));

import { registerSshHandlers } from "./sshHandlers";

const expectedVersion = {
  exists: true,
  sha256: "a".repeat(64),
  size: 8,
  mtime: 123,
};

const native = {
  listWorkspaceDirectories,
} as unknown as NativeBridge;

const getWriteHandler = (): ((...args: unknown[]) => Promise<unknown>) => {
  const handler = handlers.get("ssh:write-file");
  if (!handler) {
    throw new Error("Expected ssh:write-file handler");
  }
  return handler as (...args: unknown[]) => Promise<unknown>;
};

describe("ssh:write-file authorization", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    listWorkspaceDirectories.mockResolvedValue([
      {
        directoryId: "ssh:workspace",
        path: "ssh://snow@example.test:22/workspace",
        kind: "ssh",
      },
    ]);
    writeSshFile.mockResolvedValue({ sideEffect: "committed" });
    registerSshHandlers(native);
  });

  it("resolves the authorization root from workspaceId and rejects a Renderer root override", async () => {
    const write = getWriteHandler();

    await expect(
      write(
        {},
        "session-1",
        "/workspace/file.txt",
        "updated",
        {
          workspaceId: "ssh:workspace",
          workspaceRoot: "ssh://snow@example.test:22/",
          expectedVersion,
        }
      )
    ).rejects.toThrow("does not accept workspaceRoot");
    expect(writeSshFile).not.toHaveBeenCalled();

    await write({}, "session-1", "/workspace/file.txt", "updated", {
      workspaceId: "ssh:workspace",
      expectedVersion,
    });

    expect(resolveSshWorkspaceRoot).toHaveBeenCalledWith(
      "session-1",
      "ssh://snow@example.test:22/workspace"
    );
    expect(writeSshFile).toHaveBeenCalledWith(
      "session-1",
      "/workspace/file.txt",
      "updated",
      { workspaceRoot: "/workspace", expectedVersion }
    );
  });

  it("rejects a user-reachable save without an expectedVersion", async () => {
    const write = getWriteHandler();

    await expect(
      write({}, "session-1", "/workspace/file.txt", "updated", {
        workspaceId: "ssh:workspace",
      })
    ).rejects.toThrow("requires an expected file version");
    expect(writeSshFile).not.toHaveBeenCalled();
  });
});
