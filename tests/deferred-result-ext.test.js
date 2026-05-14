import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDeferredResultExtension } from "../lib/extensions/deferred-result-ext.js";
import { DeferredResultStore } from "../lib/deferred-result-store.js";

function createMockPi() {
  const handlers = {};
  return {
    on: vi.fn((event, handler) => {
      handlers[event] = handler;
    }),
    sendMessage: vi.fn(),
    _trigger(event, ...args) {
      handlers[event]?.(...args);
    },
  };
}

describe("DeferredResultExtension", () => {
  let store, pi, factory, coordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new DeferredResultStore();
    coordinator = {
      bindSession: vi.fn(),
      unbindSession: vi.fn(),
      enqueueTask: vi.fn(),
    };
    factory = createDeferredResultExtension(store, coordinator);
    pi = createMockPi();
    factory(pi);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes to session_start and session_shutdown", () => {
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("binds and unbinds the live session around lifecycle events", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    pi._trigger("session_shutdown");

    expect(coordinator.bindSession).toHaveBeenCalledWith("/s/a", pi);
    expect(coordinator.unbindSession).toHaveBeenCalledWith("/s/a");
  });

  it("enqueues undelivered tasks on session_start", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    store.defer("t1", "/s/a", { type: "image-generation" });
    store.resolve("t1", { files: ["img.png"] });
    vi.advanceTimersByTime(500);

    expect(coordinator.enqueueTask).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ status: "resolved", sessionPath: "/s/a" }),
    );
  });

  it("does NOT enqueue notifications for a different session during cold-start scan", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    store.defer("t1", "/s/b", { type: "image-generation" });
    store.resolve("t1", { files: [] });
    vi.advanceTimersByTime(500);
    expect(coordinator.enqueueTask).not.toHaveBeenCalled();
  });

  it("does not subscribe to live resolve/fail events per session", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    store.defer("t1", "/s/a", { type: "image-generation" });
    store.fail("t1", "credit exhausted");

    expect(coordinator.enqueueTask).not.toHaveBeenCalled();
  });

  it("unsubscribes on session_shutdown", () => {
    pi._trigger("session_start", {}, { sessionManager: { getSessionFile: () => "/s/a" } });
    pi._trigger("session_shutdown");

    expect(coordinator.unbindSession).toHaveBeenCalledWith("/s/a");
  });
});
