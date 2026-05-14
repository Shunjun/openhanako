/**
 * Deferred Result Pi SDK Extension
 *
 * On session_start:
 *   1. 绑定当前 session 的 live pi 实例到 coordinator
 *   2. 扫描未送达的已完成任务，统一进入 session inbox 调度
 *
 * coordinator 会根据 session 当前状态决定：
 *   - streaming: 等 turn_end 后批量注入
 *   - idle: 立即 steer 注入
 *   - detached: 自动恢复 session 再触发一轮处理
 *
 * 实时 resolve/fail 事件只在全局 DeferredResultStore 上注册一次；
 * extension 只负责 live pi 生命周期与 cold-start 补发，不再按 session 重复订阅。
 */

/**
 * @param {import("../deferred-result-store.js").DeferredResultStore} deferredStore
 * @param {{
 *   bindSession?: (sessionPath: string, pi: object) => void,
 *   unbindSession?: (sessionPath: string) => void,
 *   enqueueTask?: (taskId: string, task: object) => void,
 * } | null} [coordinator]
 * @returns {(pi: object) => void}
 */
export function createDeferredResultExtension(deferredStore, coordinator = null) {
  const enqueueTask = (taskId, task, pi) => {
    if (!task) return;
    if (coordinator?.enqueueTask) {
      coordinator.enqueueTask(taskId, task);
      return;
    }

    try {
      const type = String(task?.meta?.type || "background-task")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      const payload = task.status === "resolved"
        ? typeof task.result === "string"
          ? task.result
          : JSON.stringify(task.result, null, 2)
        : task.status === "aborted"
          ? (task.reason || "task was stopped")
          : task.reason;
      const body = String(payload)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      const status = task.status === "resolved"
        ? "success"
        : task.status === "aborted"
          ? "aborted"
          : "failed";
      pi.sendMessage(
        {
          customType: "hana-background-result",
          content: `<hana-background-result task-id="${String(taskId).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}" status="${status}" type="${type}">\n${body}\n</hana-background-result>`,
          display: false,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
      deferredStore.markDelivered(taskId);
    } catch (err) {
      console.error(`[deferred-result-ext] steer failed for ${taskId}:`, err.message || err, err.stack?.split('\n').slice(0, 3).join('\n'));
    }
  };

  return function (pi) {
    let sessionPath = null;

    pi.on("session_start", (event, ctx) => {
      sessionPath = ctx.sessionManager.getSessionFile();
      coordinator?.bindSession?.(sessionPath, pi);

      // ── 补发未送达的已完成任务 ──
      setTimeout(() => {
        const undelivered = deferredStore.listUndelivered(sessionPath);
        for (const task of undelivered) {
          enqueueTask(task.taskId, task, pi);
        }

        // 如果还有 pending 任务，提醒 LLM
        const pending = deferredStore.listPending(sessionPath);
        if (pending.length) {
          try {
            pi.sendMessage(
              {
                customType: "hana-deferred-task-reminder",
                content: `<hana-deferred-tasks>${pending.length} 个后台任务进行中；使用 check_pending_tasks 工具可查看详情。</hana-deferred-tasks>`,
                display: false,
              },
              { deliverAs: "steer", triggerTurn: false },
            );
          } catch { /* best effort */ }
        }
      }, 500);
    });

    pi.on("session_shutdown", () => {
      coordinator?.unbindSession?.(sessionPath);
    });
  };
}
