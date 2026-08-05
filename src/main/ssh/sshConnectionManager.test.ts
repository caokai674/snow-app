import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transports: new Map<string, { client: EventEmitter }>(),
  connectSsh: vi.fn(),
  disconnectSsh: vi.fn(),
}));

vi.mock("./sshManager", () => ({
  connectSsh: mocks.connectSsh,
  disconnectSsh: mocks.disconnectSsh,
  getSshProfileKey: ({ host, port, username }: { host: string; port: number; username: string }) =>
    `${username}@${host}:${port}`,
  getSshSession: (sessionId: string) => mocks.transports.get(sessionId),
  setSshSessionHandleResolver: vi.fn(),
}));

import { SshConnectionManager } from "./sshConnectionManager";

const params = {
  host: "ssh.example.test",
  port: 22,
  username: "snow",
  authMethod: "password" as const,
  password: "test",
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.transports.clear();
});

describe("SshConnectionManager", () => {
  it("keeps a stable profile ID while a reconnect advances generation", async () => {
    vi.useFakeTimers();
    const first = { client: new EventEmitter() };
    const second = { client: new EventEmitter() };
    mocks.transports.set("ssh-first", first);
    mocks.transports.set("ssh-second", second);
    mocks.connectSsh
      .mockResolvedValueOnce("ssh-first")
      .mockResolvedValueOnce("ssh-second");

    const manager = new SshConnectionManager({
      random: () => 0,
      reconnectDelaysMs: [0],
      idleTimeoutMs: 0,
    });
    const states: string[] = [];
    manager.subscribe((state) => states.push(`${state.status}:${state.generation}`));

    const initial = await manager.acquire(params);
    expect(initial).toMatchObject({
      profileId: "ssh-profile:snow@ssh.example.test:22",
      sessionId: "ssh-first",
      generation: 1,
      status: "connected",
    });
    expect(manager.resolveSessionId(initial.profileId)).toBe("ssh-first");

    first.client.emit("close");
    await vi.runAllTimersAsync();

    expect(manager.get(initial.profileId)).toMatchObject({
      sessionId: "ssh-second",
      generation: 2,
      status: "connected",
    });
    expect(manager.resolveSessionId(initial.profileId)).toBe("ssh-second");
    expect(states).toContain("reconnecting:1");
    expect(states).toContain("connected:2");
  });

  it("does not reconnect after the final profile reference is released", async () => {
    vi.useFakeTimers();
    const transport = { client: new EventEmitter() };
    mocks.transports.set("ssh-first", transport);
    mocks.connectSsh.mockResolvedValue("ssh-first");
    const manager = new SshConnectionManager({
      random: () => 0,
      reconnectDelaysMs: [0],
      idleTimeoutMs: 0,
    });

    const connection = await manager.acquire(params);
    manager.release(connection.profileId);
    await vi.runAllTimersAsync();
    transport.client.emit("close");
    await vi.runAllTimersAsync();

    expect(mocks.disconnectSsh).toHaveBeenCalledWith("ssh-first");
    expect(mocks.connectSsh).toHaveBeenCalledTimes(1);
    expect(manager.get(connection.profileId)).toMatchObject({ status: "idle" });
  });

  it("retains the profile and retries when the initial network handshake fails", async () => {
    vi.useFakeTimers();
    const transport = { client: new EventEmitter() };
    mocks.transports.set("ssh-recovered", transport);
    mocks.connectSsh
      .mockRejectedValueOnce(new Error("connect ECONNRESET"))
      .mockResolvedValueOnce("ssh-recovered");

    const manager = new SshConnectionManager({
      random: () => 0,
      reconnectDelaysMs: [0],
    });

    const initial = await manager.acquire(params);
    expect(initial).toMatchObject({
      profileId: "ssh-profile:snow@ssh.example.test:22",
      generation: 0,
      status: "reconnecting",
      lastError: "connect ECONNRESET",
    });

    await vi.runAllTimersAsync();

    expect(manager.get(initial.profileId)).toMatchObject({
      sessionId: "ssh-recovered",
      generation: 1,
      status: "connected",
    });
  });
});
