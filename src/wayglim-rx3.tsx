import { createRoot } from 'react-dom/client'
import WayglimBackground from './WayglimBackground'

// The Neon Ripple background for project-rx3.html. WayglimBackground.tsx is Wayglim's export, unchanged;
// this only mounts it into the page's fixed .rx-bg box, which is the positioned parent it fills.
const host = document.querySelector('.rx-bg')
if (host) createRoot(host).render(<WayglimBackground />)
