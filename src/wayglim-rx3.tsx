import { createRoot } from 'react-dom/client'
import WayglimBackground from './WayglimBackground'
import looks from './wayglim-looks.json'

// The Neon Ripple background for project-rx3.html. WayglimBackground.tsx is Wayglim's export, unchanged;
// this only mounts it into the page's fixed .rx-bg box, which is the positioned parent it fills.
// A page can change the light sheet's Spread (in %) with data-spread on .rx-bg, e.g. <div class="rx-bg" data-spread="25">.
// data-look swaps in another studio look from wayglim-looks.json (exported unchanged from the studio, settings only),
// e.g. data-look="spotlight": the Work page's Emmy card uses Spotlight and Visually Represented uses Hyperdrive.
const host = document.querySelector<HTMLElement>('.rx-bg')
if (host) {
  const spread = Number(host.dataset.spread)
  const name = host.dataset.look ?? ''
  const look = Object.hasOwn(looks, name) ? (looks as Record<string, typeof looks.spotlight>)[name] : undefined
  createRoot(host).render(<WayglimBackground look={look} params={Number.isFinite(spread) && host.dataset.spread ? { spread } : undefined} />)
}
