window.__ModuleLoader__.load({
	id: "@kewen/dsh-sidebar-plus",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/index.ts
		/**
		* @kewen/dsh-sidebar-plus Client Plugin
		* macOS 三态工作台：分栏伴生 / 宽幅工作台 / 极致沉浸
		*
		* 实现要点：
		* - 选择器锚定 DSH CSS Module 哈希格式 `xxxxx_<name>`，用 `_name` 前缀避免子串误命中
		* - 只跟踪 frame 自身的三个 data 属性（collapsed/animating/dragging），不扫子树
		* - ResizeObserver 仅作为"需要重测"的信号，统一经 measure() 单点写入 CSS 变量
		* - 卸载时还原所有 DOM 副作用（attribute + CSS 变量 + observer）
		*/
		const STYLE_ID = "@kewen/dsh-sidebar-plus-style";
		/** 插件自定义 CSS 变量与属性名（写入 documentElement） */
		const WIDTH_VAR = "--dsh-active-sidebar-width";
		const COLLAPSED_ATTR = "data-dsh-sidebar-collapsed";
		/** DSH 侧栏初始宽度（与 layoutInfo.sidebar 默认值一致） */
		const DSH_SIDEBAR_DEFAULT_PX = 280;
		/** 低于此宽度视为侧栏不可见，不写入变量 */
		const SIDEBAR_MIN_WIDTH_PX = 50;
		/** CSS Module 选择器：DSH 哈希前缀都是 `xxxxx_<name>`，用 `_name` 精确匹配 */
		const SEL = {
			frame: "[class*=\"_frame\"]",
			sidebar: "[class*=\"_sidebarCol\"]",
			center: "[class*=\"_centerCol\"]",
			leading: "[class*=\"_leadingSeat\"]",
			/** 专属 data 属性锁定，无需 class 匹配 */
			session: "[data-sidebar-right-session]:not([hidden])",
			panel: "[data-sidebar-right-panel=\"fullscreen\"]"
		};
		/** dockkit column-0 的 inline-start 避让值（px），与 DSH 原生默认对齐 */
		const STRIP_INLINE_START = {
			/** 侧栏展开：交通灯在侧栏上方，右面板无需避让 */
			sidebarExpanded: 10,
			/** 侧栏折叠 + macOS 原生全屏：交通灯隐藏，leadingSeat left:12px，容纳展开按钮 */
			sidebarCollapsedNativeFullscreen: 48
		};
		function injectSidebarPlusStyles() {
			if (typeof document === "undefined") return () => {};
			let style = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
			if (!style) {
				style = document.createElement("style");
				style.dataset.plugin = "@kewen/dsh-sidebar-plus";
				style.dataset.pluginCss = STYLE_ID;
				document.head.appendChild(style);
			}
			style.textContent = `
/* ========== 1. 层级：左侧栏 + 左上浮动按钮不被全屏面板遮挡 ========== */
[data-platform="darwin"] ${SEL.sidebar} {
  position: relative;
  z-index: 50;
}
[data-platform="darwin"] ${SEL.leading} {
  z-index: 60 !important;
  pointer-events: auto !important;
}

/* ========== 2. 遮罩：前台活跃会话全屏时隐藏底层聊天流 ========== */
[data-platform="darwin"] ${SEL.frame}[data-rightbar-fullscreen]:has(${SEL.session} ${SEL.panel}) ${SEL.center} {
  visibility: hidden !important;
  transition: visibility 0s linear var(--ds-transition-duration-slow, 0.3s) !important;
}

/* ========== 3. 布局：态2 / 态3 ========== */
/* 基准：靠右对齐，与原生网格动画同频 */
[data-platform="darwin"] ${SEL.session} ${SEL.panel} {
  left: auto !important;
  right: 0 !important;
  transition: max-width var(--ds-transition-duration-slow, 0.22s) var(--ds-ease-in-out, cubic-bezier(0.16, 1, 0.3, 1)) !important;
}
/* 态2：侧栏展开 → 右面板宽度 = 100vw - 侧栏宽度 */
[data-platform="darwin"] ${SEL.frame}:not([data-sidebar-collapsed]) ${SEL.session} ${SEL.panel} {
  max-width: calc(100vw - var(${WIDTH_VAR}, ${DSH_SIDEBAR_DEFAULT_PX}px)) !important;
}
/* 态3：侧栏折叠 → 100% 满屏 */
[data-platform="darwin"] ${SEL.frame}[data-sidebar-collapsed] ${SEL.session} ${SEL.panel} {
  max-width: 100vw !important;
}

/* ========== 4. Chrome 微调：dockkit column-0 的 inline-start 避让 ========== */
/* 侧栏展开（窗口化或原生全屏）：交通灯在侧栏上方，右面板无需避让 */
[data-platform="darwin"] ${SEL.frame}:not([data-sidebar-collapsed]) ${SEL.session} ${SEL.panel} [data-dockkit-host="dock"][data-dockkit-column="0"] {
  --dsh-dockkit-strip-inline-start: ${STRIP_INLINE_START.sidebarExpanded}px !important;
}
/* 侧栏折叠 + macOS 原生全屏：交通灯隐藏，leadingSeat left:12px，容纳展开按钮 */
html[data-platform="darwin"][data-fullscreen] ${SEL.frame}[data-sidebar-collapsed] ${SEL.session} ${SEL.panel} [data-dockkit-host="dock"][data-dockkit-column="0"] {
  --dsh-dockkit-strip-inline-start: ${STRIP_INLINE_START.sidebarCollapsedNativeFullscreen}px !important;
}
/* 注：侧栏折叠 + 窗口化（非原生全屏）沿用原生 88px，无需覆盖 */

/* ========== 5. 无障碍 ========== */
@media (prefers-reduced-motion: reduce) {
  [data-platform="darwin"] ${SEL.panel} {
    transition: none !important;
  }
}
`;
			return () => {
				style?.remove();
			};
		}
		var SidebarTracker = class {
			root;
			rafId = null;
			frameEl = null;
			sidebarEl = null;
			lastCollapsed = null;
			resizeObserver = null;
			frameObserver = null;
			probeObserver = null;
			disposed = false;
			constructor(root) {
				this.root = root;
			}
			start() {
				this.attachResizeObserver();
				this.schedule();
				this.bindObservers();
			}
			dispose() {
				this.disposed = true;
				if (this.rafId !== null) cancelAnimationFrame(this.rafId);
				this.resizeObserver?.disconnect();
				this.frameObserver?.disconnect();
				this.probeObserver?.disconnect();
				this.sidebarEl = null;
				this.frameEl = null;
				this.root.removeAttribute(COLLAPSED_ATTR);
				this.root.style.removeProperty(WIDTH_VAR);
			}
			readFrameState() {
				if (!this.frameEl || !this.frameEl.isConnected) this.frameEl = document.querySelector(SEL.frame);
				if (!this.frameEl) return {
					collapsed: false,
					animating: false,
					dragging: false
				};
				return {
					collapsed: this.frameEl.hasAttribute("data-sidebar-collapsed"),
					animating: this.frameEl.hasAttribute("data-animating"),
					dragging: this.frameEl.hasAttribute("data-dragging")
				};
			}
			setCollapsedAttr(collapsed) {
				if (this.lastCollapsed === collapsed) return;
				this.lastCollapsed = collapsed;
				this.root.setAttribute(COLLAPSED_ATTR, collapsed ? "true" : "false");
			}
			setSidebarWidth(widthPx) {
				this.root.style.setProperty(WIDTH_VAR, `${Math.round(widthPx)}px`);
			}
			measure = () => {
				if (this.disposed) return;
				const { collapsed, animating, dragging } = this.readFrameState();
				this.setCollapsedAttr(collapsed);
				if (collapsed || animating && !dragging) return;
				const sidebarEl = this.sidebarEl?.isConnected ? this.sidebarEl : document.querySelector(SEL.sidebar);
				if (!sidebarEl) return;
				const width = sidebarEl.getBoundingClientRect().width;
				if (width > SIDEBAR_MIN_WIDTH_PX) this.setSidebarWidth(width);
			};
			schedule = () => {
				if (this.rafId !== null || this.disposed) return;
				this.rafId = requestAnimationFrame(() => {
					this.rafId = null;
					this.measure();
				});
			};
			attachResizeObserver = () => {
				if (typeof ResizeObserver === "undefined") return;
				const el = document.querySelector(SEL.sidebar);
				if (!el || el === this.sidebarEl) return;
				this.resizeObserver?.disconnect();
				this.sidebarEl = el;
				this.resizeObserver = new ResizeObserver((entries) => {
					const { collapsed, animating, dragging } = this.readFrameState();
					if (collapsed || animating && !dragging) return;
					for (const entry of entries) {
						const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
						if (width > SIDEBAR_MIN_WIDTH_PX) this.setSidebarWidth(width);
					}
				});
				this.resizeObserver.observe(el);
				this.measure();
			};
			bindFrame = () => {
				const el = document.querySelector(SEL.frame);
				if (!el || el === this.frameEl) return;
				this.frameObserver?.disconnect();
				this.frameEl = el;
				this.frameObserver = new MutationObserver(this.schedule);
				this.frameObserver.observe(el, {
					attributes: true,
					attributeFilter: [
						"data-sidebar-collapsed",
						"data-animating",
						"data-dragging"
					]
				});
			};
			bindAll = () => {
				this.bindFrame();
				this.attachResizeObserver();
			};
			bindObservers() {
				if (typeof MutationObserver === "undefined") return;
				this.bindAll();
				this.probeObserver = new MutationObserver(this.bindAll);
				this.probeObserver.observe(this.root, {
					childList: true,
					subtree: true
				});
			}
		};
		function setupSidebarTracker() {
			if (typeof window === "undefined" || typeof document === "undefined") return () => {};
			const root = document.documentElement;
			if (root.dataset.platform !== "darwin") return () => {};
			const tracker = new SidebarTracker(root);
			tracker.start();
			return () => tracker.dispose();
		}
		const inject = ["sidebarRight"];
		function apply(ctx) {
			try {
				ctx.effect(() => {
					const cleanupStyles = injectSidebarPlusStyles();
					const cleanupTracker = setupSidebarTracker();
					return () => {
						cleanupStyles();
						cleanupTracker();
					};
				}, "sidebar-plus: core layout effect");
			} catch (e) {
				console.warn("[dsh-sidebar-plus] activation error", e);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map