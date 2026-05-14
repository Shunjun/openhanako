/**
 * ProxyManager — 全局 HTTP/HTTPS 代理管理
 *
 * 单一职责：管理 undici 全局 dispatcher，使所有 globalThis.fetch 请求走代理。
 * 不涉及配置持久化（由 PreferencesManager 负责）。
 *
 * Node.js 22.16+ 内置 undici，EnvHttpProxyAgent 自动读取环境变量。
 * 调用 setGlobalDispatcher() 后立即生效，无需重启服务。
 */
import { EnvHttpProxyAgent, setGlobalDispatcher, Agent } from "undici";

export class ProxyManager {
  constructor() {
    this._applied = false;
  }

  /** 当前是否已启用代理 */
  get applied() {
    return this._applied;
  }

  /**
   * 应用代理配置到全局 fetch dispatcher。
   * @param {object} proxy - 代理配置
   * @param {boolean} proxy.enabled - 是否启用
   * @param {string} [proxy.url] - 代理地址（http://host:port 或 socks5://host:port）
   * @param {string} [proxy.username] - 代理用户名（可选）
   * @param {string} [proxy.password] - 代理密码（可选）
   * @param {string} [proxy.no_proxy] - 不走代理的地址（逗号分隔，可选）
   */
  apply(proxy) {
    if (!proxy?.enabled || !proxy?.url) {
      this.disable();
      return;
    }

    try {
      const proxyUrl = new URL(proxy.url);
      if (proxy.username && proxy.password) {
        proxyUrl.username = encodeURIComponent(proxy.username);
        proxyUrl.password = encodeURIComponent(proxy.password);
      }
      const finalUrl = proxyUrl.toString();

      process.env.HTTP_PROXY = finalUrl;
      process.env.HTTPS_PROXY = finalUrl;

      if (proxy.no_proxy) {
        process.env.NO_PROXY = proxy.no_proxy;
      } else {
        delete process.env.NO_PROXY;
      }

      setGlobalDispatcher(new EnvHttpProxyAgent());
      this._applied = true;
      console.log(`[proxy] applied: ${proxy.url}`);
    } catch (err) {
      console.warn(`[proxy] failed to apply: ${err.message}`);
      this._applied = false;
    }
  }

  /** 禁用代理，恢复直连 */
  disable() {
    try {
      setGlobalDispatcher(new Agent());
    } catch {
      // undici 不可用时忽略
    }
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.NO_PROXY;
    this._applied = false;
    console.log("[proxy] disabled");
  }
}
