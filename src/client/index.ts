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

// ---------------------------------------------------------------------------
// 常量：DSH 布局契约
// ---------------------------------------------------------------------------

const STYLE_ID = '@kewen/dsh-sidebar-plus-style'

/** 插件自定义 CSS 变量与属性名（写入 documentElement） */
const WIDTH_VAR = '--dsh-active-sidebar-width'
const COLLAPSED_ATTR = 'data-dsh-sidebar-collapsed'

/** DSH 侧栏初始宽度（与 layoutInfo.sidebar 默认值一致） */
const DSH_SIDEBAR_DEFAULT_PX = 280
/** 低于此宽度视为侧栏不可见，不写入变量 */
const SIDEBAR_MIN_WIDTH_PX = 50

/** CSS Module 选择器：DSH 哈希前缀都是 `xxxxx_<name>`，用 `_name` 精确匹配 */
const SEL = {
  frame: '[class*="_frame"]',
  sidebar: '[class*="_sidebarCol"]',
  center: '[class*="_centerCol"]',
  leading: '[class*="_leadingSeat"]',
  /** 专属 data 属性锁定，无需 class 匹配 */
  session: '[data-sidebar-right-session]:not([hidden])',
  panel: '[data-sidebar-right-panel="fullscreen"]',
} as const

/** dockkit column-0 的 inline-start 避让值（px），与 DSH 原生默认对齐 */
const STRIP_INLINE_START = {
  /** 侧栏展开：交通灯在侧栏上方，右面板无需避让 */
  sidebarExpanded: 10,
  /** 侧栏折叠 + macOS 原生全屏：交通灯隐藏，leadingSeat left:12px，容纳展开按钮 */
  sidebarCollapsedNativeFullscreen: 48,
} as const

// ---------------------------------------------------------------------------
// CSS 注入
// ---------------------------------------------------------------------------

function injectSidebarPlusStyles(): () => void {
  if (typeof document === 'undefined') return () => {}

  let style = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_ID}"]`)
  if (!style) {
    style = document.createElement('style')
    style.dataset.plugin = '@kewen/dsh-sidebar-plus'
    style.dataset.pluginCss = STYLE_ID
    document.head.appendChild(style)
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
`

  return () => {
    style?.remove()
  }
}

// ---------------------------------------------------------------------------
// 侧栏追踪器：把"读 DOM 状态 → 写 CSS 变量"的数据流收敛到 class 字段上
// 写入出口有两个（各自最优数据源）：
//   - ResizeObserver 回调：免费拿到 borderBoxSize，拖拽时逐像素更新
//   - measure()：兜底路径，用 getBoundingClientRect 处理 collapsed 属性同步和非 RO 场景
// ---------------------------------------------------------------------------

class SidebarTracker {
  private readonly root: HTMLElement
  private rafId: number | null = null
  private frameEl: Element | null = null
  private sidebarEl: Element | null = null
  private lastCollapsed: boolean | null = null
  private resizeObserver: ResizeObserver | null = null
  private frameObserver: MutationObserver | null = null
  private probeObserver: MutationObserver | null = null
  private disposed = false

  constructor(root: HTMLElement) {
    this.root = root
  }

  start(): void {
    this.attachResizeObserver()
    this.schedule()
    this.bindObservers()
  }

  dispose(): void {
    this.disposed = true
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.resizeObserver?.disconnect()
    this.frameObserver?.disconnect()
    this.probeObserver?.disconnect()
    this.sidebarEl = null
    this.frameEl = null
    // 还原写入的 DOM 状态
    this.root.removeAttribute(COLLAPSED_ATTR)
    this.root.style.removeProperty(WIDTH_VAR)
  }

  // ----- 读取：frame 三态标记 -----

  private readFrameState() {
    if (!this.frameEl || !this.frameEl.isConnected) {
      this.frameEl = document.querySelector(SEL.frame)
    }
    if (!this.frameEl) {
      return { collapsed: false, animating: false, dragging: false }
    }
    return {
      collapsed: this.frameEl.hasAttribute('data-sidebar-collapsed'),
      animating: this.frameEl.hasAttribute('data-animating'),
      dragging: this.frameEl.hasAttribute('data-dragging'),
    }
  }

  // ----- 写入：CSS 变量 / 属性（单点出口） -----

  private setCollapsedAttr(collapsed: boolean): void {
    if (this.lastCollapsed === collapsed) return
    this.lastCollapsed = collapsed
    this.root.setAttribute(COLLAPSED_ATTR, collapsed ? 'true' : 'false')
  }

  private setSidebarWidth(widthPx: number): void {
    this.root.style.setProperty(WIDTH_VAR, `${Math.round(widthPx)}px`)
  }

  // ----- 核心：测量并把状态同步到 CSS -----

  private measure = (): void => {
    if (this.disposed) return
    const { collapsed, animating, dragging } = this.readFrameState()
    this.setCollapsedAttr(collapsed)

    // 动画期间不写中间宽度，避免与 CSS grid transition 打架
    if (collapsed || (animating && !dragging)) return

    const sidebarEl = this.sidebarEl?.isConnected ? this.sidebarEl : document.querySelector(SEL.sidebar)
    if (!sidebarEl) return
    const width = sidebarEl.getBoundingClientRect().width
    if (width > SIDEBAR_MIN_WIDTH_PX) this.setSidebarWidth(width)
  }

  private schedule = (): void => {
    if (this.rafId !== null || this.disposed) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      this.measure()
    })
  }

  // ----- 元素绑定 -----

  private attachResizeObserver = (): void => {
    if (typeof ResizeObserver === 'undefined') return
    const el = document.querySelector(SEL.sidebar)
    if (!el || el === this.sidebarEl) return
    this.resizeObserver?.disconnect()
    this.sidebarEl = el
    // RO 的 entry 自带免费测量值，避免 getBoundingClientRect 的强制 layout；
    // collapsed / animating 时跳过写变量，但不影响 collapsed 属性的同步（由 measure 负责）
    this.resizeObserver = new ResizeObserver((entries) => {
      const { collapsed, animating, dragging } = this.readFrameState()
      if (collapsed || (animating && !dragging)) return
      for (const entry of entries) {
        const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
        if (width > SIDEBAR_MIN_WIDTH_PX) this.setSidebarWidth(width)
      }
    })
    this.resizeObserver.observe(el)
    // 同步跑一次，让变量立刻落地，避免 CSS fallback 闪烁
    this.measure()
  }

  private bindFrame = (): void => {
    const el = document.querySelector(SEL.frame)
    if (!el || el === this.frameEl) return
    this.frameObserver?.disconnect()
    this.frameEl = el
    this.frameObserver = new MutationObserver(this.schedule)
    this.frameObserver.observe(el, {
      attributes: true,
      attributeFilter: ['data-sidebar-collapsed', 'data-animating', 'data-dragging'],
    })
  }

  private bindAll = (): void => {
    this.bindFrame()
    this.attachResizeObserver()
  }

  private bindObservers(): void {
    if (typeof MutationObserver === 'undefined') return
    this.bindAll()
    // probe 长驻，仅在 frame/sidebar 首次出现或换绑时工作；只 querySelector，不写 DOM
    this.probeObserver = new MutationObserver(this.bindAll)
    this.probeObserver.observe(this.root, { childList: true, subtree: true })
  }
}

function setupSidebarTracker(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}

  const root = document.documentElement
  // 非 macOS 桌面端不需要任何测量——CSS 也全部限定 darwin，直接短路
  if (root.dataset.platform !== 'darwin') return () => {}

  const tracker = new SidebarTracker(root)
  tracker.start()
  return () => tracker.dispose()
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

interface PluginEffectHandle {
  (run: () => () => void, label?: string): void
}

interface PluginContext {
  effect: PluginEffectHandle
}

export const inject = [
  'sidebarRight',
]

export function apply(ctx: PluginContext): void {
  try {
    ctx.effect(() => {
      const cleanupStyles = injectSidebarPlusStyles()
      const cleanupTracker = setupSidebarTracker()
      return () => {
        cleanupStyles()
        cleanupTracker()
      }
    }, 'sidebar-plus: core layout effect')
  } catch (e) {
    console.warn('[dsh-sidebar-plus] activation error', e)
  }
}
