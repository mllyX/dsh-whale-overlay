/**
 * dsh-whale-overlay — browser half.
 *
 * 侧栏 foot 区的一张控制卡「🐋 桌面鲸鱼」：
 *  - 桌面模式开关（即时拉起/关闭全屏悬浮鲸鱼）
 *  - 运行状态点（运行中 / 已停用 / 组件未装 / 出错）
 *  - 「设置」入口（新标签打开 /dsh-whale-overlay/settings.html）
 *  - 需要重启 DSH 才能隐藏/恢复界面内挂件时给出提示
 *
 * 与 dsh-provider-usage 相同的手工客户端模块写法：
 * window.__ModuleLoader__.load —— 不需要平台种子、纯 DOM、不碰 React 树。
 */
window.__ModuleLoader__.load({
  id: "dsh-whale-overlay",
  factory: () => {
    const CARD_ATTR = "data-dsh-whale-overlay-card";
    const API = "/dsh-whale-overlay";
    const POLL_MS = 30_000;

    const state = { timer: 0, installPoll: 0, state: null, busy: false };

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    // ── 样式（主题中性：跟随 body 前景色 + color-mix 生成表面色）──────────
    function mountStyle() {
      const style = document.createElement("style");
      style.textContent = `
        [${CARD_ATTR}] {
          margin: 6px 0; padding: 8px 10px; border-radius: 10px;
          border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
          background: color-mix(in srgb, currentColor 5%, transparent);
          font-size: 12px; line-height: 1.5; user-select: none;
        }
        [${CARD_ATTR}] .dwo-head {
          display: flex; align-items: center; gap: 6px; font-weight: 600;
        }
        [${CARD_ATTR}] .dwo-dot {
          width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto;
          background: color-mix(in srgb, currentColor 30%, transparent);
        }
        [${CARD_ATTR}] .dwo-dot.ok { background: #2fbf71; }
        [${CARD_ATTR}] .dwo-dot.warn { background: #e5a63c; }
        [${CARD_ATTR}] .dwo-dot.err { background: #ef5b5b; }
        [${CARD_ATTR}] .dwo-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        [${CARD_ATTR}] .dwo-switch {
          flex: 0 0 auto; border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
          background: color-mix(in srgb, currentColor 8%, transparent);
          color: inherit; border-radius: 999px; padding: 2px 10px; cursor: pointer; font: inherit;
        }
        [${CARD_ATTR}] .dwo-switch[data-on="1"] {
          background: #4d6bfe; border-color: #4d6bfe; color: #fff;
        }
        [${CARD_ATTR}] .dwo-switch:disabled { opacity: .5; cursor: default; }
        [${CARD_ATTR}] .dwo-status {
          margin-top: 4px; color: color-mix(in srgb, currentColor 68%, transparent);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        [${CARD_ATTR}] .dwo-hint { margin-top: 4px; color: #e5a63c; display: none; }
        [${CARD_ATTR}] .dwo-hint.show { display: block; }
        [${CARD_ATTR}] .dwo-links { margin-top: 6px; display: flex; gap: 10px; }
        [${CARD_ATTR}] .dwo-links a, [${CARD_ATTR}] .dwo-links button {
          background: none; border: none; padding: 0; cursor: pointer; font: inherit;
          color: #4d6bfe; text-decoration: none;
        }
        [${CARD_ATTR}] .dwo-links a:hover, [${CARD_ATTR}] .dwo-links button:hover { text-decoration: underline; }
      `;
      document.head.append(style);
      return style;
    }

    // ── 卡片 DOM ──────────────────────────────────────────────────────────
    const container = el("div");
    container.setAttribute(CARD_ATTR, "");
    const dot = el("span", "dwo-dot");
    const title = el("span", "dwo-title", "🐋 桌面鲸鱼");
    const toggle = el("button", "dwo-switch", "开启");
    toggle.type = "button";
    toggle.dataset.on = "0";
    const head = el("div", "dwo-head");
    head.append(dot, title, toggle);
    const statusLine = el("div", "dwo-status", "读取状态…");
    const hint = el("div", "dwo-hint");
    const links = el("div", "dwo-links");
    const settingsLink = el("a", "", "设置");
    settingsLink.href = API + "/settings.html";
    settingsLink.target = "_blank";
    settingsLink.rel = "noopener";
    const installBtn = el("button", "", "安装桌面组件");
    installBtn.type = "button";
    installBtn.style.display = "none";
    links.append(settingsLink, installBtn);
    container.append(head, statusLine, hint, links);

    // ── 数据 ──────────────────────────────────────────────────────────────
    async function fetchState() {
      const r = await fetch(API + "/state.json", { credentials: "same-origin" });
      if (!r.ok) throw new Error("state " + r.status);
      return r.json();
    }

    async function putConfig(patch) {
      const r = await fetch(API + "/config.json", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      return r.json();
    }

    function render() {
      const s = state.state;
      if (!s) return;
      const cfg = s.config || {};
      const ov = s.overlay || {};
      toggle.dataset.on = cfg.enabled ? "1" : "0";
      toggle.textContent = cfg.enabled ? "关闭" : "开启";
      toggle.disabled = state.busy;

      if (!s.widget || !s.widget.detected) {
        dot.className = "dwo-dot err";
        statusLine.textContent = "未检测到 dsh-whale-widget 挂件插件";
      } else if (!s.helper || !s.helper.installed) {
        dot.className = "dwo-dot warn";
        statusLine.textContent = "桌面组件（Electron）未安装";
      } else if (cfg.enabled && ov.running) {
        dot.className = "dwo-dot " + (ov.ready ? "ok" : "warn");
        statusLine.textContent = (ov.ready ? "悬浮中" : "启动中…") + " · pid " + ov.pid;
      } else if (cfg.enabled) {
        dot.className = "dwo-dot err";
        statusLine.textContent = "悬浮窗未运行" + (ov.lastError ? "：" + String(ov.lastError).slice(0, 80) : "");
      } else {
        dot.className = "dwo-dot";
        statusLine.textContent = "已停用（鲸鱼只在 DSH 界面内）";
      }

      const needRestart = !!s.restartNeededForSuppress;
      hint.textContent = needRestart
        ? "⚠ 界面内挂件的隐藏/恢复需重启 DSH 生效"
        : "";
      hint.classList.toggle("show", needRestart);

      const showInstall = !!(s.helper && !s.helper.installed);
      installBtn.style.display = showInstall ? "" : "none";
      if (s.install && s.install.status === "running") {
        installBtn.textContent = "安装中…";
        installBtn.disabled = true;
      } else {
        installBtn.textContent = "安装桌面组件";
        installBtn.disabled = false;
      }
    }

    async function refresh() {
      try {
        state.state = await fetchState();
        render();
      } catch {
        dot.className = "dwo-dot err";
        statusLine.textContent = "状态服务不可达";
      }
    }

    toggle.addEventListener("click", async () => {
      if (state.busy || !state.state) return;
      const next = !(state.state.config && state.state.config.enabled);
      state.busy = true;
      toggle.disabled = true;
      toggle.textContent = next ? "启动中…" : "关闭中…";
      try {
        await putConfig({ enabled: next });
        await new Promise((r) => setTimeout(r, 600));
        await refresh();
      } catch {
        /* refresh 会展示错误态 */
      } finally {
        state.busy = false;
        toggle.disabled = false;
        render();
      }
    });

    installBtn.addEventListener("click", async () => {
      installBtn.disabled = true;
      installBtn.textContent = "安装中…";
      try {
        await fetch(API + "/install-helper", { method: "POST", credentials: "same-origin" });
      } catch {}
      if (state.installPoll !== 0) clearInterval(state.installPoll);
      state.installPoll = setInterval(async () => {
        await refresh();
        const ins = state.state && state.state.install;
        if (!ins || ins.status !== "running") {
          clearInterval(state.installPoll);
          state.installPoll = 0;
          installBtn.disabled = false;
        }
      }, 3000);
    });

    // ── 挂载（侧栏 foot 区，排在 provider-usage / usage 卡片之上）─────────
    function footArea() {
      const sidebar = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
      return (sidebar && sidebar.querySelector('[class*="footArea"]')) || undefined;
    }

    function place() {
      const foot = footArea();
      if (foot === undefined) return;
      const anchor =
        foot.querySelector("[data-dsh-provider-usage-card]") ||
        foot.querySelector("[data-dsh-usage-foot-card]") ||
        foot.querySelector('[class*="settingsArea"]');
      if (anchor !== null && anchor !== undefined) {
        if (container.nextElementSibling !== anchor) foot.insertBefore(container, anchor);
      } else if (foot.lastElementChild !== container) {
        foot.append(container);
      }
    }

    function mount() {
      const style = mountStyle();
      place();
      let frame = 0;
      const observer = new MutationObserver(() => {
        if (frame !== 0) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (!container.isConnected) place();
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });

      void refresh();
      state.timer = window.setInterval(() => {
        if (document.visibilityState === "visible") void refresh();
      }, POLL_MS);

      return () => {
        window.clearInterval(state.timer);
        if (state.installPoll !== 0) window.clearInterval(state.installPoll);
        observer.disconnect();
        if (frame !== 0) cancelAnimationFrame(frame);
        container.remove();
        style.remove();
      };
    }

    /** Client plugin entry. */
    function apply(ctx) {
      if (typeof document === "undefined") return;
      const dispose = mount();
      if (ctx && typeof ctx.effect === "function") {
        ctx.effect(() => dispose, "dsh-whale-overlay: card");
      }
    }

    const bundleExports = {};
    Object.defineProperty(bundleExports, Symbol.toStringTag, { value: "Module" });
    bundleExports.apply = apply;
    bundleExports.inject = [];
    return bundleExports;
  },
});
