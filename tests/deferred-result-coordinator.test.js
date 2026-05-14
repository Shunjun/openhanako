import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeferredResultCoordinator } from "../lib/deferred-result-coordinator.js";
import { DeferredResultStore } from "../lib/deferred-result-store.js";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("DeferredResultCoordinator", () => {
  let engine;
  let store;
  let coordinator;
  let sessionState;
  let sessionListener;

  beforeEach(() => {
    sessionState = null;
    sessionListener = null;
    engine = {
      subscribe: vi.fn((listener) => {
        sessionListener = listener;
        return () => { sessionListener = null; };
      }),
      getSessionByPath: vi.fn(() => sessionState),
      ensureSessionLoaded: vi.fn(async () => sessionState),
      promptSession: vi.fn(async () => {}),
      isSessionStreaming: vi.fn(() => !!sessionState?.isStreaming),
    };
    store = { markDelivered: vi.fn() };
    coordinator = new DeferredResultCoordinator({
      engine,
      deferredStore: store,
      warn: () => {},
      retryDelayMs: 10,
    });
  });

  it("immediately steers completed tasks to an idle live session", async () => {
    sessionState = { isStreaming: false };
    const pi = { sendMessage: vi.fn() };
    coordinator.bindSession("/s/a", pi);
    coordinator.enqueueTask("t1", {
      sessionPath: "/s/a",
      status: "resolved",
      result: "done",
      meta: { type: "subagent" },
      delivered: false,
    });

    await flushMicrotasks();

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].content).toContain('task-id="t1"');
    expect(store.markDelivered).toHaveBeenCalledWith("t1");
  });

  it("waits for turn_end before flushing tasks for a streaming session", async () => {
    sessionState = { isStreaming: true };
    const pi = { sendMessage: vi.fn() };
    coordinator.bindSession("/s/a", pi);
    coordinator.enqueueTask("t1", {
      sessionPath: "/s/a",
      status: "resolved",
      result: "first",
      meta: {},
      delivered: false,
    });
    coordinator.enqueueTask("t2", {
      sessionPath: "/s/a",
      status: "failed",
      reason: "boom",
      meta: {},
      delivered: false,
    });

    await flushMicrotasks();
    expect(pi.sendMessage).not.toHaveBeenCalled();

    sessionState = { isStreaming: false };
    sessionListener?.({ type: "turn_end" }, "/s/a");
    await flushMicrotasks();

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const content = pi.sendMessage.mock.calls[0][0].content;
    expect(content).toContain('task-id="t1"');
    expect(content).toContain('task-id="t2"');
    expect(store.markDelivered).toHaveBeenCalledWith("t1");
    expect(store.markDelivered).toHaveBeenCalledWith("t2");
  });

  it("treats session_status=true as busy even if session.isStreaming is false", async () => {
    sessionState = { isStreaming: false };
    const pi = { sendMessage: vi.fn() };
    coordinator.bindSession("/s/a", pi);
    sessionListener?.({ type: "session_status", isStreaming: true }, "/s/a");

    coordinator.enqueueTask("t1", {
      sessionPath: "/s/a",
      status: "resolved",
      result: "late result",
      meta: {},
      delivered: false,
    });

    await flushMicrotasks();
    expect(pi.sendMessage).not.toHaveBeenCalled();

    sessionListener?.({ type: "turn_end" }, "/s/a");
    await flushMicrotasks();

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.markDelivered).toHaveBeenCalledWith("t1");
  });

  it("does not spin while a detached restored session is still streaming", async () => {
    engine.ensureSessionLoaded.mockImplementation(async () => {
      sessionState ??= { isStreaming: true };
      return sessionState;
    });

    coordinator.enqueueTask("t1", {
      sessionPath: "/s/a",
      status: "resolved",
      result: "late result",
      meta: {},
      delivered: false,
    });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(engine.ensureSessionLoaded).toHaveBeenCalledTimes(1);
    expect(engine.promptSession).not.toHaveBeenCalled();
    expect(store.markDelivered).not.toHaveBeenCalled();

    sessionState = { isStreaming: false };
    sessionListener?.({ type: "turn_end" }, "/s/a");
    await flushMicrotasks();

    expect(engine.promptSession).toHaveBeenCalledTimes(1);
    expect(engine.promptSession.mock.calls[0][1]).toContain('task-id="t1"');
    expect(store.markDelivered).toHaveBeenCalledWith("t1");
  });

  it("restores a detached session and reuses steer delivery when the live binding comes back", async () => {
    const pi = { sendMessage: vi.fn() };
    engine.ensureSessionLoaded.mockImplementation(async (sessionPath) => {
      sessionState = { isStreaming: false };
      coordinator.bindSession(sessionPath, pi);
      return sessionState;
    });

    coordinator.enqueueTask("t1", {
      sessionPath: "/s/a",
      status: "resolved",
      result: "restored",
      meta: {},
      delivered: false,
    });

    await flushMicrotasks();

    expect(engine.ensureSessionLoaded).toHaveBeenCalledWith("/s/a");
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(engine.promptSession).not.toHaveBeenCalled();
    expect(store.markDelivered).toHaveBeenCalledWith("t1");
  });

  it("falls back to prompt delivery when restore does not produce a live binding", async () => {
    engine.ensureSessionLoaded.mockImplementation(async () => {
      sessionState = { isStreaming: false };
      return sessionState;
    });

    coordinator.enqueueTask("t1", {
      sessionPath: "/s/a",
      status: "resolved",
      result: "needs prompt",
      meta: {},
      delivered: false,
    });

    await flushMicrotasks();

    expect(engine.ensureSessionLoaded).toHaveBeenCalledWith("/s/a");
    expect(engine.promptSession).toHaveBeenCalledTimes(1);
    expect(engine.promptSession.mock.calls[0][1]).toContain('task-id="t1"');
    expect(store.markDelivered).toHaveBeenCalledWith("t1");
  });

  it("coalesces multiple detached results into one recovery flush", async () => {
    let resolveRestore;
    const restorePromise = new Promise((resolve) => {
      resolveRestore = resolve;
    });
    const pi = { sendMessage: vi.fn() };

    engine.ensureSessionLoaded.mockImplementation(async (sessionPath) => {
      await restorePromise;
      sessionState = { isStreaming: false };
      coordinator.bindSession(sessionPath, pi);
      return sessionState;
    });

    coordinator.enqueueTask("t1", {
      sessionPath: "/s/a",
      status: "resolved",
      result: "one",
      meta: {},
      delivered: false,
    });
    coordinator.enqueueTask("t2", {
      sessionPath: "/s/a",
      status: "resolved",
      result: "two",
      meta: {},
      delivered: false,
    });

    await flushMicrotasks();
    expect(engine.ensureSessionLoaded).toHaveBeenCalledTimes(1);

    resolveRestore();
    await flushMicrotasks();

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const content = pi.sendMessage.mock.calls[0][0].content;
    expect(content).toContain('task-id="t1"');
    expect(content).toContain('task-id="t2"');
  });

  it("can wake a detached session from global store callbacks after live session shutdown", async () => {
    const actualStore = new DeferredResultStore();
    const pi = { sendMessage: vi.fn() };

    engine.ensureSessionLoaded.mockImplementation(async (sessionPath) => {
      sessionState = { isStreaming: false };
      coordinator.bindSession(sessionPath, pi);
      return sessionState;
    });

    actualStore.onResult((taskId) => {
      const task = actualStore.query(taskId);
      if (task) coordinator.enqueueTask(taskId, task);
    });

    sessionState = { isStreaming: false };
    coordinator.bindSession("/s/a", pi);
    coordinator.unbindSession("/s/a");
    sessionState = null;

    actualStore.defer("t1", "/s/a", { type: "subagent" });
    actualStore.resolve("t1", "late result");

    await flushMicrotasks();

    expect(engine.ensureSessionLoaded).toHaveBeenCalledWith("/s/a");
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].content).toContain('task-id="t1"');
  });
});
