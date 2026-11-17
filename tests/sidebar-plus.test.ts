import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { beginGlobalDrag } from '@kewen/dsh-ui/host-bridge'
import {
  apply,
  inject,
  injectSidebarPlusStyles,
  parseSidebarColumn,
  SIDEBAR_PLUS_CSS,
  SidebarWidthSync,
  STYLE_ID,
  WIDTH_VAR,
} from '../src/client/index.ts'

const require = createRequire(import.meta.url)
interface JsdomInstance {
  window: Window & typeof globalThis & { close(): void }
}
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string) => JsdomInstance
}

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')

function withDom<T>(
  html: string,
  fn: (win: JsdomInstance['window'], doc: Document) => Promise<T> | T,
): Promise<T> {
  const dom = new JSDOM(html)
  const prevWin = globalThis.window
  const prevDoc = globalThis.document
  const prevMO = globalThis.MutationObserver
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
  })
  return Promise.resolve()
    .then(() => fn(dom.window, dom.window.document))
    .finally(() => {
      Object.assign(globalThis, {
        window: prevWin,
        document: prevDoc,
        MutationObserver: prevMO,
      })
      dom.window.close()
    })
}

const flushMutations = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('@kewen/dsh-sidebar-plus', () => {
  it('parseSidebarColumn extracts leading pixel column width and rejects non-px columns', () => {
    assert.equal(parseSidebarColumn('280px minmax(0, 1fr) 0px'), 280)
    assert.equal(parseSidebarColumn('0px minmax(0, 1fr) minmax(0, 1fr)'), 0)
    assert.equal(parseSidebarColumn('  312.5px 1fr'), 312.5)
    assert.equal(parseSidebarColumn('minmax(0, 1fr) 320px'), null)
    assert.equal(parseSidebarColumn('auto 1fr'), null)
    assert.equal(parseSidebarColumn(''), null)
  })

  it('injectSidebarPlusStyles mounts data-plugin-css style with --dsh-ease-out curve and cleans up idempotently', async () => {
    await withDom('<!doctype html><html><head></head><body></body></html>', (_win, doc) => {
      const dispose = injectSidebarPlusStyles()
      const style = doc.head.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_ID}"]`)
      assert.ok(style, 'plugin stylesheet mounted in document.head')
      assert.equal(style.textContent, SIDEBAR_PLUS_CSS)
      assert.match(
        style.textContent ?? '',
        /var\(--dsh-ease-out,\s*var\(--ds-ease-in-out,\s*ease-in-out\)\)/,
      )
      assert.match(style.textContent ?? '', /html\[data-dsh-dragging\]\s+iframe/)

      // Re-injecting updates in place without duplicating <style>
      const dispose2 = injectSidebarPlusStyles()
      assert.equal(
        doc.head.querySelectorAll(`style[data-plugin-css="${STYLE_ID}"]`).length,
        1,
      )

      dispose()
      dispose()
      dispose2()
      assert.equal(doc.head.querySelector(`style[data-plugin-css="${STYLE_ID}"]`), null)
    })
  })

  it('SidebarWidthSync tracks gridTemplateColumns and manages [data-dragging] beginGlobalDrag() lifecycle', async () => {
    await withDom(
      '<!doctype html><html data-platform="darwin"><head></head><body><div id="frame" style="grid-template-columns: 264px minmax(0, 1fr) 0px"><div data-shell-overlay></div></div></body></html>',
      async (_win, doc) => {
        const root = doc.documentElement
        const frame = doc.getElementById('frame')!
        const sync = new SidebarWidthSync(root, doc)
        sync.start()

        assert.equal(root.style.getPropertyValue(WIDTH_VAR), '264px')
        assert.equal(root.hasAttribute('data-dsh-dragging'), false)

        // Resize + start dragging: updates CSS var and activates global drag shield
        frame.style.gridTemplateColumns = '310.4px minmax(0, 1fr) 480px'
        frame.setAttribute('data-dragging', '')
        await flushMutations()

        assert.equal(root.style.getPropertyValue(WIDTH_VAR), '310px')
        assert.equal(root.hasAttribute('data-dsh-dragging'), true)

        // Coexists with concurrent ref-counted beginGlobalDrag() callers
        const endExternalDrag = beginGlobalDrag(doc)
        frame.removeAttribute('data-dragging')
        await flushMutations()
        assert.equal(root.hasAttribute('data-dsh-dragging'), true, 'external drag still holds shield')
        endExternalDrag()
        assert.equal(root.hasAttribute('data-dsh-dragging'), false, 'shield released once all drags end')

        // Disposing while [data-dragging] is still set releases global drag and cleans up WIDTH_VAR
        frame.setAttribute('data-dragging', '')
        await flushMutations()
        assert.equal(root.hasAttribute('data-dsh-dragging'), true)

        sync.dispose()
        assert.equal(root.hasAttribute('data-dsh-dragging'), false, 'dispose releases active drag shield')
        assert.equal(root.style.getPropertyValue(WIDTH_VAR), '', 'dispose removes --dsh-active-sidebar-width')
      },
    )
  })

  it('apply(ctx) wires inject + style + darwin sync and restores cleanly on effect dispose', async () => {
    assert.deepEqual(inject, ['sidebarRight'])
    await withDom(
      '<!doctype html><html data-platform="darwin"><head></head><body><div id="frame" style="grid-template-columns: 280px 1fr 0px"><div data-shell-overlay></div></div></body></html>',
      async (_win, doc) => {
        const disposers: Array<() => void> = []
        apply({
          effect(run) {
            disposers.push(run())
          },
        })
        assert.ok(doc.head.querySelector(`style[data-plugin-css="${STYLE_ID}"]`))
        assert.equal(doc.documentElement.style.getPropertyValue(WIDTH_VAR), '280px')

        const frame = doc.getElementById('frame')!
        frame.setAttribute('data-dragging', '')
        await flushMutations()
        assert.equal(doc.documentElement.hasAttribute('data-dsh-dragging'), true)

        while (disposers.length > 0) disposers.pop()?.()
        assert.equal(doc.head.querySelector(`style[data-plugin-css="${STYLE_ID}"]`), null)
        assert.equal(doc.documentElement.hasAttribute('data-dsh-dragging'), false)
        assert.equal(doc.documentElement.style.getPropertyValue(WIDTH_VAR), '')
      },
    )
  })

  it('lib/client.js inline-bundles @kewen/dsh-ui helpers with zero external @kewen/dsh-ui references', () => {
    const bundlePath = resolve(pluginRoot, 'lib', 'client.js')
    const bundle = readFileSync(bundlePath, 'utf8')
    assert.match(bundle, /window\.__ModuleLoader__\.load\(\{\s*id:\s*"@kewen\/dsh-sidebar-plus"/)
    assert.doesNotMatch(bundle, /require\s*\(\s*['"]@kewen\/dsh-ui/)
    assert.doesNotMatch(bundle, /from\s+['"]@kewen\/dsh-ui/)
    assert.match(bundle, /data-dsh-dragging/)
    assert.match(bundle, /data-plugin-css/)
  })
})
