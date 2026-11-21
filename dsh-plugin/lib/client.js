/**
 * dsh-paper-agent 浏览器半边。
 *
 * 在 Harness 左侧注册一个「术语透视」入口，点开后在主区整页承载阅读界面。
 * 阅读界面本身仍是 paper-agent 自己的前端（挂载在 /paper-agent/），
 * 因此高亮、气泡、术语面板、选段解释、译文、导出、追问都与独立版完全一致。
 *
 * 打包格式是 Harness 的 lazy-CJS 模块工厂（window.__ModuleLoader__），
 * 只依赖运行时模块表里的 react，不需要额外构建步骤。
 */
window.__ModuleLoader__.load({
  id: "dsh-paper-agent",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;

    /** 侧边栏入口与主面板共用同一个 id。 */
    var PANEL_ID = "paper-agent";
    var FALLBACK_BASE = "/paper-agent/";

    function PanelIcon(props) {
      var size = (props && props.size) || 18;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("path", { d: "M5 4.6A2.6 2.6 0 0 1 7.6 2H19v16.4H7.6A2.6 2.6 0 0 0 5 21z" }),
        h("path", { d: "M9 6.4h6.2M9 9.6h6.2M9 12.8h4" }),
      );
    }

    function useBasePath() {
      var state = react.useState(FALLBACK_BASE);
      var basePath = state[0];
      var setBasePath = state[1];

      react.useEffect(() => {
        var alive = true;
        fetch("/paper-agent/_meta.json", { credentials: "same-origin" })
          .then((response) => (response.ok ? response.json() : null))
          .then((meta) => {
            if (!alive || !meta || typeof meta.basePath !== "string") return;
            setBasePath(meta.basePath.replace(/\/+$/, "") + "/");
          })
          .catch(() => {
            /* 用默认路径 */
          });
        return () => {
          alive = false;
        };
      }, []);

      return basePath;
    }

    function PaperAgentPage() {
      var basePath = useBasePath();
      var reloadState = react.useState(0);
      var nonce = reloadState[0];
      var setNonce = reloadState[1];
      var [ready, setReady] = react.useState(false);

      react.useEffect(() => {
        setReady(false);
      }, [nonce]);

      var toolbar = h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px",
            borderBottom: "1px solid rgba(127, 127, 127, 0.18)",
            fontSize: 12,
            letterSpacing: 0.2,
            color: "inherit",
            background: "transparent",
            flex: "0 0 auto",
          },
        },
        h(
          "span",
          { style: { display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 } },
          h(PanelIcon, { size: 15 }),
          "术语透视",
        ),
        h(
          "span",
          { style: { opacity: 0.55 } },
          "原文不动 · 术语高亮 · 点开就解释",
        ),
        h("span", { style: { flex: 1 } }),
        h(
          "button",
          {
            type: "button",
            onClick: () => setNonce((value) => value + 1),
            title: "重新加载阅读页",
            style: buttonStyle,
          },
          "刷新",
        ),
        h(
          "button",
          {
            type: "button",
            onClick: () => window.open(basePath, "_blank", "noopener"),
            title: "在新标签页打开",
            style: buttonStyle,
          },
          "新窗口",
        ),
      );

      return h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            height: "100%",
            minHeight: 0,
            background: "var(--dsh-surface, transparent)",
          },
        },
        toolbar,
        h("iframe", {
          key: nonce,
          src: basePath,
          title: "术语透视 · 论文阅读与术语解释",
          onLoad: () => setReady(true),
          style: {
            flex: 1,
            width: "100%",
            border: "none",
            background: "#f7fbfd",
            opacity: ready ? 1 : 0.35,
            transition: "opacity 180ms ease",
          },
        }),
      );
    }

    var buttonStyle = {
      fontSize: 12,
      padding: "3px 10px",
      borderRadius: 6,
      border: "1px solid rgba(127, 127, 127, 0.28)",
      background: "transparent",
      color: "inherit",
      cursor: "pointer",
      lineHeight: "18px",
    };

    function apply(ctx) {
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID }, PaperAgentPage),
      );
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 1,
            label: "术语透视",
          },
          PanelIcon,
        ),
      );
    }

    exports.PANEL_ID = PANEL_ID;
    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
