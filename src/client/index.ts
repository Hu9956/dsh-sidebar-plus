/**
 * @kewen/dsh-sidebar-plus Client Plugin
 * macOS 三态工作台：分栏伴生 / 宽幅工作台 / 极致沉浸
 *
 * 实现要点：
 * - 选择器只用 DSH 宿主渲染的 data 属性（data-shell-* / data-rightbar-col / data-sidebar-right-*），
 *   不按 CSS Module 类名子串匹配
 * - 侧栏宽度直接取 frame 内联 gridTemplateColumns 的第一列（宿主 computeColumns 的结果），
 *   不测量 DOM；折叠时宿主在 darwin 上写 0px
 * - 顶栏避让沿用宿主的 --dsh-frame-leading-clearance（窗口化 160px / 原生全屏 84px）
 * - 不改左侧栏层级：面板宽度已限制为 100vw - 侧栏宽度，二者不重叠
 * - 卸载时还原所有 DOM 副作用（样式 + CSS 变量 + observer）
 */

// ---------------------------------------------------------------------------
// 常量：DSH 布局契约
// ---------------------------------------------------------------------------

const STYLE_ID = '@kewen/dsh-sidebar-plus-style'

/** 插件自定义 CSS 变量（写入 documentElement） */
const WIDTH_VAR = '--dsh-active-sidebar-width'

/** DSH 侧栏初始宽度（与 layoutInfo.sidebar 默认值一致），仅作 JS 写入前的回退 */
const DSH_SIDEBAR_DEFAULT_PX = 280

/**
 * 选择器全部锚定宿主 data 属性：
 * - frame：AppFrame 根节点，唯一带 [data-shell-overlay] 直接子节点的元素
 * - center：紧邻 [data-rightbar-col] 之前的列（CenterColumn）
 */
const SEL = {
  frame: ':has(> [data-shell-overlay])',
  overlay: '[data-shell-overlay]',
  center: ':has(+ [data-rightbar-col])',
  leading: '[data-shell-leading]',
  session: '[data-sidebar-right-session]:not([hidden])',
  panel: '[data-sidebar-right-panel="fullscreen"]',
} as const

/** 侧栏展开时 dockkit column-0 的 inline-start（交通灯在侧栏上方，无需避让） */
const STRIP_INLINE_START_EXPANDED_PX = 10

/**
 * 侧栏折叠且右面板全屏时，左上角按钮（宿主 z-index 15）会被 Tab 栏（dock layer 40）盖住。
 * 只在这一状态下抬到 41：高于 Tab 栏，低于浮动窗（float layer 60）。
 */
const LEADING_LAYER_OVER_FULLSCREEN = 41

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

  const D = '[data-platform="darwin"]'
  const F = `${D} ${SEL.frame}`
  const P = `${SEL.session} ${SEL.panel}`
  const COL0 = '[data-dockkit-host="dock"][data-dockkit-column="0"]'

  style.textContent = `
/* ========== 1. 遮罩：前台活跃会话全屏时隐藏底层聊天流 ========== */
${F}[data-rightbar-fullscreen]:has(${P}) > ${SEL.center} {
  visibility: hidden !important;
  transition: visibility 0s linear var(--ds-transition-duration-slow, 0.3s) !important;
}

/* ========== 2. 布局：全屏面板让出左侧栏 ========== */
/* 宿主在 darwin 上折叠时侧栏列为 0px，同一条规则覆盖态2 / 态3 */
${F} ${P} {
  max-width: calc(100vw - var(${WIDTH_VAR}, ${DSH_SIDEBAR_DEFAULT_PX}px)) !important;
  transition: max-width var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, ease-in-out) !important;
}
/* 拖拽侧栏时宿主关闭了网格过渡，面板同步跟手 */
${F}[data-dragging] ${P} {
  transition: none !important;
}

/* ========== 3. Chrome：dockkit column-0 的 inline-start 避让 ========== */
/* 侧栏展开：交通灯在侧栏上方，无需避让 */
${F}:not([data-sidebar-collapsed]) ${P} ${COL0} {
  --dsh-dockkit-strip-inline-start: ${STRIP_INLINE_START_EXPANDED_PX}px !important;
}
/* 侧栏折叠：让出交通灯 + 左上角按钮。基于宿主避让值（窗口化 160px / 原生全屏 84px），
   再加 Tab 栏原生的 10px 间距：窗口化按钮占 88–164px，单用 160px 会压住 4px */
${F}[data-sidebar-collapsed] ${P} ${COL0} {
  --dsh-dockkit-strip-inline-start: calc(var(--dsh-frame-leading-clearance, 160px) + ${STRIP_INLINE_START_EXPANDED_PX}px) !important;
}

/* ========== 4. 层级：折叠 + 全屏时左上角按钮不被 Tab 栏盖住 ========== */
/* 全屏时宿主 dock layer 为 40；按钮抬到 41，仍低于 float layer 60 */
${F}[data-rightbar-fullscreen]:has(${P}) > ${SEL.leading} {
  z-index: ${LEADING_LAYER_OVER_FULLSCREEN} !important;
}

/* ========== 5. 无障碍 ========== */
@media (prefers-reduced-motion: reduce) {
  ${F} ${P} {
    transition: none !important;
  }
}
`

  return () => {
    style?.remove()
  }
}

// ---------------------------------------------------------------------------
// 侧栏宽度同步：frame 内联 gridTemplateColumns → CSS 变量
// ---------------------------------------------------------------------------

/** 解析 `280px minmax(...) minmax(...)` 的第一列，失败返回 null */
export function parseSidebarColumn(gridTemplateColumns: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)px\b/.exec(gridTemplateColumns)
  return match ? Number(match[1]) : null
}

class SidebarWidthSync {
  private readonly root: HTMLElement
  private frameEl: HTMLElement | null = null
  private lastWidth: number | null = null
  /** 监听 frame 的 style（宿主每次重算列宽都会改写内联 gridTemplateColumns） */
  private frameObserver: MutationObserver | null = null
  /** 已绑定时只看 frame 父节点的直接子节点，未绑定时看整棵树 */
  private probeObserver: MutationObserver | null = null
  private disposed = false

  constructor(root: HTMLElement) {
    this.root = root
  }

  start(): void {
    if (typeof MutationObserver === 'undefined') return
    this.bind()
  }

  dispose(): void {
    this.disposed = true
    this.frameObserver?.disconnect()
    this.probeObserver?.disconnect()
    this.frameObserver = null
    this.probeObserver = null
    this.frameEl = null
    this.root.style.removeProperty(WIDTH_VAR)
  }

  private findFrame(): HTMLElement | null {
    return document.querySelector<HTMLElement>(SEL.overlay)?.parentElement ?? null
  }

  private sync = (): void => {
    if (this.disposed || !this.frameEl) return
    const width = parseSidebarColumn(this.frameEl.style.gridTemplateColumns)
    if (width === null || width === this.lastWidth) return
    this.lastWidth = width
    this.root.style.setProperty(WIDTH_VAR, `${Math.round(width)}px`)
  }

  private bind = (): void => {
    if (this.disposed) return
    if (this.frameEl?.isConnected) return
    const frame = this.findFrame()

    this.frameObserver?.disconnect()
    this.probeObserver?.disconnect()
    this.frameObserver = null
    this.frameEl = frame

    if (!frame) {
      // 还没渲染：等任意子树变化后重试
      this.probeObserver = new MutationObserver(this.bind)
      this.probeObserver.observe(this.root, { childList: true, subtree: true })
      return
    }

    this.frameObserver = new MutationObserver(this.sync)
    this.frameObserver.observe(frame, { attributes: true, attributeFilter: ['style'] })
    // frame 被替换时，其父节点的直接子节点会变化
    this.probeObserver = new MutationObserver(this.bind)
    this.probeObserver.observe(frame.parentNode ?? this.root, { childList: true })
    this.sync()
  }
}

function setupSidebarWidthSync(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}

  const root = document.documentElement
  // 非 macOS 桌面端不需要同步——CSS 也全部限定 darwin，直接短路
  if (root.dataset.platform !== 'darwin') return () => {}

  const sync = new SidebarWidthSync(root)
  sync.start()
  return () => sync.dispose()
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

// apply 里不直接使用 ctx.sidebarRight；inject 它是为了等右侧栏服务就绪后才 apply，
// 右侧栏缺席时本插件不生效（全部样式都作用在右侧栏 DOM 上），不要改成空数组。
export const inject = [
  'sidebarRight',
]

export function apply(ctx: PluginContext): void {
  try {
    ctx.effect(() => {
      const cleanupStyles = injectSidebarPlusStyles()
      const cleanupSync = setupSidebarWidthSync()
      return () => {
        cleanupStyles()
        cleanupSync()
      }
    }, 'sidebar-plus: core layout effect')
  } catch (e) {
    console.warn('[dsh-sidebar-plus] activation error', e)
  }
}
