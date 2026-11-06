import { createRoot } from 'react-dom/client'
import WayglimBackground from './WayglimBackground'

// The Neon Ripple background for project-rx3.html. WayglimBackground.tsx is Wayglim's export, unchanged;
// this only mounts it into the page's fixed .rx-bg box, which is the positioned parent it fills.
// A page can change the light sheet's Spread (in %) with data-spread on .rx-bg, e.g. <div class="rx-bg" data-spread="25">.
const host = document.querySelector<HTMLElement>('.rx-bg')
if (host) {
  const spread = Number(host.dataset.spread)
  createRoot(host).render(<WayglimBackground params={Number.isFinite(spread) && host.dataset.spread ? { spread } : undefined} />)
}
