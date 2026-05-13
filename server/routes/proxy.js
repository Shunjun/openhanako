/**
 * 代理配置 REST 路由
 *
 * GET  /api/proxy         — 读取代理设置
 * PUT  /api/proxy         — 更新代理设置（立即生效）
 * POST /api/proxy/test    — 测试代理连接
 */
import { Hono } from "hono";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { safeJson } from "../hono-helpers.js";

export function createProxyRoute(engine) {
  const route = new Hono();

  // 读取代理设置
  route.get("/proxy", (c) => {
    try {
      const proxy = engine.getProxy();
      return c.json({ proxy });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 更新代理设置（立即应用到全局 dispatcher）
  route.put("/proxy", async (c) => {
    try {
      const body = await safeJson(c);
      if (!body || typeof body !== "object") {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      engine.setProxy(body);
      return c.json({ ok: true, proxy: engine.getProxy() });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // 测试代理连接
  route.post("/proxy/test", async (c) => {
    try {
      const body = await safeJson(c);
      const url = body?.url;
      if (!url) return c.json({ error: "url is required" }, 400);

      // 临时构建测试用 dispatcher
      const proxyUrl = new URL(url);
      if (body.username && body.password) {
        proxyUrl.username = encodeURIComponent(body.username);
        proxyUrl.password = encodeURIComponent(body.password);
      }
      const dispatcher = new ProxyAgent(proxyUrl.toString());

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const resp = await undiciFetch("https://httpbin.org/ip", {
          dispatcher,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const data = await resp.json();
        return c.json({ ok: true, ip: data.origin });
      } catch (err) {
        clearTimeout(timeout);
        return c.json({ ok: false, error: err.message }, 400);
      }
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  return route;
}
