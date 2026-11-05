// Glisse on the static pages: built to assets/glass.js by `npm run build:glass`.
// Plain HTML stays the source of truth: glass goes behind existing elements,
// and native switches/sliders stay in the DOM (hidden) as the value page scripts read and write.
import { useEffect, useReducer } from 'react'
import { createRoot } from 'react-dom/client'
import { Glass, Slider, Switch } from 'glisse'
import 'glisse/styles.css'
import './glass.css'

// #glass-distortion: the homepage bundle's old SVG-filter glass (dock, hero pills).
// #root: project pages use .section-label as a plain heading, not a pill.
const SURFACES = '.nav, #root .section-label, div:has(> [style*="glass-distortion"]), #chat, .chat-pop, #connect, #quicklook > figure, #quicklook > figure > figcaption, #ql-vol, #ql-transport'
// Not Glisse's own range input inside each Slider.
const INPUTS = 'input[type=checkbox][role=switch], input[type=range]:not(.lg-slider input)'

function surface(el: HTMLElement) {
  if (el.querySelector(':scope > .glass-layer')) return   // already done (or re-added after an innerHTML swap)
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
  el.dataset.glassHost = ''   // not a class: the homepage bundle rewrites the nav's className on scroll
  const layer = document.createElement('span')
  layer.className = 'glass-layer'
  el.prepend(layer)
  createRoot(layer).render(<Glass />)
}

// Script writes to the hidden input (seek.max = d, box.checked = on) redraw the Glisse control.
function watch(el: HTMLInputElement, redraw: () => void) {
  for (const key of ['value', 'checked', 'min', 'max', 'disabled']) {
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, key)!
    Object.defineProperty(el, key, {
      configurable: true,
      get() { return native.get!.call(this) },
      set(v) { native.set!.call(this, v); redraw() },
    })
  }
}

function Bridge({ el }: { el: HTMLInputElement }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => watch(el, redraw), [el])
  const emit = () => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const label = el.getAttribute('aria-label') ?? undefined
  if (el.type === 'checkbox')
    return <Switch aria-label={label} checked={el.checked} disabled={el.disabled}
      onCheckedChange={c => { el.checked = c; emit() }} />
  return <Slider aria-label={label} disabled={el.disabled} value={+el.value}
    min={el.min === '' ? 0 : +el.min} max={el.max === '' ? 100 : +el.max} step={+el.step || 1}
    onValueChange={v => { el.value = String(v); emit() }} />
}

function input(el: HTMLInputElement) {
  if (el.dataset.glass != null) return
  el.dataset.glass = ''
  el.style.display = 'none'
  const host = document.createElement('span')
  host.className = 'glass-input'
  el.after(host)
  createRoot(host).render(<Bridge el={el} />)
}

// The homepage bundle and chat.js render some targets after load, so keep looking.
let queued = false
function scan() {
  queued = false
  document.querySelectorAll<HTMLElement>(SURFACES).forEach(surface)
  document.querySelectorAll<HTMLInputElement>(INPUTS).forEach(input)
}
new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(scan) } })
  .observe(document.documentElement, { childList: true, subtree: true })
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', scan)
else scan()
