import type { ReactNode } from "react";

/** Purple radial glow over a grid, anchored top-right. */
export const GradientGridRight = ({ children }: { children?: ReactNode }) => (
  <div className="min-h-screen w-full bg-white relative">
    <div
      className="absolute inset-0 z-0"
      style={{
        backgroundImage: `
          linear-gradient(to right, #f0f0f0 1px, transparent 1px),
          linear-gradient(to bottom, #f0f0f0 1px, transparent 1px),
          radial-gradient(circle 800px at 100% 200px, #d5c5ff, transparent)
        `,
        backgroundSize: "96px 64px, 96px 64px, 100% 100%",
      }}
    />
    {children}
  </div>
);

/** Grid that fades out below the fold via a radial mask. */
export const TopFadeGrid = ({ children }: { children?: ReactNode }) => (
  <div className="min-h-screen w-full bg-[#f8fafc] relative">
    <div
      className="absolute inset-0 z-0"
      style={{
        backgroundImage: `
          linear-gradient(to right, #e2e8f0 1px, transparent 1px),
          linear-gradient(to bottom, #e2e8f0 1px, transparent 1px)
        `,
        backgroundSize: "20px 30px",
        WebkitMaskImage:
          "radial-gradient(ellipse 70% 60% at 50% 0%, #000 60%, transparent 100%)",
        maskImage:
          "radial-gradient(ellipse 70% 60% at 50% 0%, #000 60%, transparent 100%)",
      }}
    />
    {children}
  </div>
);
