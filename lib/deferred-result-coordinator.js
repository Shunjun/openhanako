function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatDeferredTaskContent(taskId, task) {
  const type = escapeXml(task?.meta?.type || "background-task");
  if (task?.status === "resolved") {
    const body = typeof task.result === "string"
      ? escapeXml(task.result)
      : escapeXml(JSON.stringify(task.result, null, 2));
    return `<hana-background-result task-id="${escapeXml(taskId)}" status="success" type="${type}">\n${body}\n</hana-background-result>`;
  }
  if (task?.status === "aborted") {
    return `<hana-background-result task-id="${escapeXml(taskId)}" status="aborted" type="${type}">\n${escapeXml(task.reason || "task was stopped")}\n</hana-background-result>`;
  }
  return `<hana-background-result task-id="${escapeXml(taskId)}" status="failed" type="${type}">\n${escapeXml(task?.reason || "unknown error")}\n</hana-background-result>`;
}

export function formatDeferredBatchContent(tasks) {
  return tasks
    .map((task) => formatDeferredTaskContent(task.taskId, task))
    .join("\n");
}

export function formatDeferredBatchPrompt(tasks) {
  return [
    "以下是后台子任务刚刚返回的结果，请直接基于这些结果继续处理，不要重复创建同类后台任务。",
    "",
    formatDeferredBatchContent(tasks),
  ].join("\n");
}

export class DeferredResultCoordinator {
  /**
   * @param {{
   *   engine: {
   *     subscribe?: (listener: (event: object, sessionPath?: string|null) => void) => (() => void),
   *     getSessionByPath?: (sessionPath: string) => object|null,
   *     ensureSessionLoaded?: (sessionPath: string) => Promise<object|null>,
   *     promptSession?: (sessionPath: string, text: string) => Promise<void>,
   *     isSessionStreaming?: (sessionPath: string) => boolean,
   *   },
   *   deferredStore: { markDelivered: (taskId: string) => void },
   *   retryDelayMs?: number,
   *   warn?: (msg: string) => void,
   * }} opts
   */
  constructor({ engine, deferredStore, retryDelayMs = 1000, warn } = {}) {
    this._engine = engine || null;
    this._store = deferredStore || null;
    this._retryDelayMs = retryDelayMs;
    this._warn = typeof warn === "function" ? warn : (msg) => console.warn(msg);
    this._liveSessions = new Map();
    this._sessionBusy = new Map();
    this._buckets = new Map();
    this._unsubscribe = this._engine?.subscribe?.((event, sessionPath) => {
      if (!sessionPath) return;
      if (event?.type === "session_status") {
        this._setSessionBusy(sessionPath, event.isStreaming === true);
        if (event.isStreaming !== true) this._requestFlush(sessionPath);
        return;
      }
      if (event?.type === "turn_end") {
        this._setSessionBusy(sessionPath, false);
        this._requestFlush(sessionPath);
        return;
      }
      if (event?.type === "message_end" && event?.message?.stopReason === "error") {
        this._setSessionBusy(sessionPath, false);
        this._requestFlush(sessionPath);
      }
    }) || null;
  }

  bindSession(sessionPath, pi) {
    if (!sessionPath || !pi) return;
    this._liveSessions.set(sessionPath, { pi });
    this._requestFlush(sessionPath);
  }

  unbindSession(sessionPath) {
    if (!sessionPath) return;
    this._liveSessions.delete(sessionPath);
  }

  _setSessionBusy(sessionPath, busy) {
    if (!sessionPath) return;
    if (busy) {
      this._sessionBusy.set(sessionPath, true);
      return;
    }
    this._sessionBusy.delete(sessionPath);
  }

  enqueueTask(taskId, task) {
    if (!taskId || !task?.sessionPath || task.delivered) return;
    const bucket = this._getBucket(task.sessionPath);
    bucket.items.set(taskId, { taskId, ...task });
    bucket.lastSeenState = this._getSessionState(task.sessionPath);
    if (bucket.lastSeenState !== "active_busy" && bucket.lastSeenState !== "detached_busy") {
      this._requestFlush(task.sessionPath);
    }
  }

  _getBucket(sessionPath) {
    let bucket = this._buckets.get(sessionPath);
    if (!bucket) {
      bucket = {
        items: new Map(),
        flushing: false,
        scheduled: false,
        needsFlush: false,
        restoring: false,
        retryTimer: null,
        lastSeenState: null,
      };
      this._buckets.set(sessionPath, bucket);
    }
    return bucket;
  }

  _requestFlush(sessionPath) {
    const bucket = this._buckets.get(sessionPath);
    if (!bucket) return;
    if (bucket.flushing) {
      bucket.needsFlush = true;
      return;
    }
    if (bucket.scheduled) return;
    bucket.scheduled = true;
    queueMicrotask(() => {
      const current = this._buckets.get(sessionPath);
      if (!current) return;
      current.scheduled = false;
      void this._flushSession(sessionPath);
    });
  }

  _getSessionState(sessionPath) {
    const binding = this._liveSessions.get(sessionPath);
    const session = this._engine?.getSessionByPath?.(sessionPath) || null;
    const busy = this._sessionBusy.get(sessionPath) === true;
    const sessionStreaming = session?.isStreaming === true;
    if (binding?.pi) return (busy || sessionStreaming) ? "active_busy" : "active_idle";
    return (busy || sessionStreaming) ? "detached_busy" : "detached_idle";
  }

  async _flushSession(sessionPath) {
    const bucket = this._buckets.get(sessionPath);
    if (!bucket || bucket.flushing || bucket.items.size === 0) return;

    bucket.flushing = true;
    try {
      while (bucket.items.size > 0) {
        bucket.needsFlush = false;
        bucket.lastSeenState = this._getSessionState(sessionPath);
        if (bucket.lastSeenState === "active_busy" || bucket.lastSeenState === "detached_busy") break;

        let taskIds = null;
        const tasks = Array.from(bucket.items.values());

        if (bucket.lastSeenState === "detached_idle") {
          const restored = await this._restoreSession(sessionPath, bucket);
          if (!restored) break;
          bucket.lastSeenState = this._getSessionState(sessionPath);
          if (bucket.lastSeenState === "active_busy" || bucket.lastSeenState === "detached_busy") break;
        }

        if (bucket.lastSeenState === "active_idle") {
          taskIds = this._deliverToLiveSession(sessionPath, tasks);
        }

        if (!taskIds?.length) {
          taskIds = await this._deliverViaPrompt(sessionPath, tasks);
        }

        if (!taskIds?.length) break;

        for (const taskId of taskIds) {
          bucket.items.delete(taskId);
          this._store?.markDelivered?.(taskId);
        }

        if (!bucket.needsFlush) break;
      }
    } catch (err) {
      this._warn(`[deferred-result-coordinator] flush failed for ${sessionPath}: ${err?.message || err}`);
      this._scheduleRetry(sessionPath);
    } finally {
      bucket.flushing = false;
      if (bucket.items.size === 0) {
        this._disposeBucket(sessionPath);
      } else {
        const currentState = this._getSessionState(sessionPath);
        if (
          bucket.needsFlush
          || (currentState !== "active_busy" && currentState !== "detached_busy")
        ) {
          this._requestFlush(sessionPath);
        }
      }
    }
  }

  async _restoreSession(sessionPath, bucket) {
    if (bucket.restoring) return false;
    bucket.restoring = true;
    try {
      await this._engine?.ensureSessionLoaded?.(sessionPath);
      return true;
    } catch (err) {
      this._warn(`[deferred-result-coordinator] restore failed for ${sessionPath}: ${err?.message || err}`);
      this._scheduleRetry(sessionPath);
      return false;
    } finally {
      bucket.restoring = false;
    }
  }

  _deliverToLiveSession(sessionPath, tasks) {
    const binding = this._liveSessions.get(sessionPath);
    if (!binding?.pi) return null;
    try {
      binding.pi.sendMessage(
        {
          customType: "hana-background-result",
          content: formatDeferredBatchContent(tasks),
          display: false,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
      return tasks.map((task) => task.taskId);
    } catch (err) {
      this._warn(`[deferred-result-coordinator] steer failed for ${sessionPath}: ${err?.message || err}`);
      this._scheduleRetry(sessionPath);
      return null;
    }
  }

  async _deliverViaPrompt(sessionPath, tasks) {
    if (!this._engine?.promptSession) return null;
    if (this._engine?.isSessionStreaming?.(sessionPath)) return null;
    try {
      await this._engine.promptSession(sessionPath, formatDeferredBatchPrompt(tasks));
      return tasks.map((task) => task.taskId);
    } catch (err) {
      if (err?.message === "session_busy") return null;
      this._warn(`[deferred-result-coordinator] prompt fallback failed for ${sessionPath}: ${err?.message || err}`);
      this._scheduleRetry(sessionPath);
      return null;
    }
  }

  _scheduleRetry(sessionPath) {
    const bucket = this._buckets.get(sessionPath);
    if (!bucket || bucket.retryTimer) return;
    bucket.retryTimer = setTimeout(() => {
      bucket.retryTimer = null;
      this._requestFlush(sessionPath);
    }, this._retryDelayMs);
    bucket.retryTimer.unref?.();
  }

  _disposeBucket(sessionPath) {
    const bucket = this._buckets.get(sessionPath);
    if (!bucket || bucket.items.size > 0) return;
    if (bucket.retryTimer) {
      clearTimeout(bucket.retryTimer);
      bucket.retryTimer = null;
    }
    this._buckets.delete(sessionPath);
  }
}
