// Glisse on the static pages: built to assets/glass.js by `npm run build:glass`.
// Plain HTML stays the source of truth: glass goes behind existing elements,
// and native switches/sliders stay in the DOM (hidden) as the value page scripts read and write.
import { useEffect, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Glass, Slider, Switch, TabBar } from 'glisse'
import 'glisse/styles.css'
import './glass.css'

// #glass-distortion: the homepage bundle's old SVG-filter glass (dock, hero pills).
// #root: project pages use .section-label as a plain heading, not a pill.
const SURFACES = '.nav, .nav__links, .nav__mark, #root .section-label, div:has(> [style*="glass-distortion"]), #chat, .chat-pop, #connect, #quicklook > figure, #quicklook > figure > figcaption, #ql-vol, #ql-transport'
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

// The work page's category links (.work-tabs, from work-cards.js) as a Glisse tab bar. Each tab links to its
// section's heading; the selection follows whichever section's heading has passed the top third of the window.
type Tab = { value: string; label: string; href: string }
function WorkTabs({ items }: { items: Tab[] }) {
  const [value, setValue] = useState(items[0].value)
  // The page scrolls smoothly, so on the way to a chosen section the selection holds on it rather than
  // stepping through the ones passed (until it's reached, or the scroll is cut short).
  const going = useRef<string | null>(null)
  useEffect(() => {
    const spy = () => {
      let v = items[0].value
      for (const { value } of items)
        if ((document.getElementById(value)?.getBoundingClientRect().top ?? Infinity) < innerHeight / 3) v = value
      if (going.current && going.current !== v) return
      going.current = null
      setValue(v)
    }
    spy()
    addEventListener('scroll', spy, { passive: true })
    return () => removeEventListener('scroll', spy)
  }, [items])
  // Every way of choosing a tab (tap, drag, Enter) ends in a click on its link, which does the scrolling.
  const go = (v: string) => {
    going.current = v
    setTimeout(() => { if (going.current === v) going.current = null }, 1500)
    setValue(v)
  }
  return <TabBar aria-label="Work categories" items={items} value={value} onValueChange={go} />
}

function tabs(el: HTMLElement) {
  if (el.dataset.glass != null) return
  el.dataset.glass = ''
  const items = [...el.querySelectorAll('a')].map(a => ({ value: a.hash.slice(1), label: a.textContent ?? '', href: a.hash }))
  el.replaceChildren()
  createRoot(el).render(<WorkTabs items={items} />)
}

// The S mark: static pages draw it as an SVG and the homepage bundle as a span with a gradient.
// Glass needs an HTML box, so wrap the SVG; the span already is one.
function mark(el: Element) {
  if (el.tagName.toLowerCase() === 'svg') {
    const box = document.createElement('span')
    el.replaceWith(box)
    box.append(el)
    el = box
  }
  el.classList.add('nav__mark')
}

// .nav__inner holds still across pages, but a view-transition-name makes it a backdrop root,
// so glass inside it (the S, the phone menu) would bend and frost nothing. Name it only while
// a page transition runs. Before this script runs, .nav itself carries the name (view-transition.css).
function holdNav(vt: { finished: Promise<unknown> } | null | undefined) {
  const inner = document.querySelector<HTMLElement>('.nav[data-glass-host] > .nav__inner')
  if (!vt || !inner) return
  inner.style.viewTransitionName = 'nav'
  vt.finished.finally(() => { inner.style.viewTransitionName = '' })
}
for (const type of ['pageswap', 'pagereveal'])
  addEventListener(type, e => holdNav((e as Event & { viewTransition?: { finished: Promise<unknown> } }).viewTransition))

// The homepage bundle and chat.js render some targets after load, so keep looking.
let queued = false
function scan() {
  queued = false
  document.querySelectorAll('.nav__logo > svg:first-child, .nav__logo > span:first-child:not(.nav__mark)').forEach(mark)
  document.querySelectorAll<HTMLElement>(SURFACES).forEach(surface)
  document.querySelectorAll<HTMLInputElement>(INPUTS).forEach(input)
  document.querySelectorAll<HTMLElement>('.work-tabs').forEach(tabs)
}
new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(scan) } })
  .observe(document.documentElement, { childList: true, subtree: true })
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', scan)
else scan()
