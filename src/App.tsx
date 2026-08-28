import { GradientGridRight, TopFadeGrid } from '@/components/ui/gradient-blur-bg'

export default function App() {
  return (
    <>
      <GradientGridRight>
        <h1 className="relative z-10 p-16 text-5xl font-semibold">GradientGridRight</h1>
      </GradientGridRight>
      <TopFadeGrid>
        <h1 className="relative z-10 p-16 text-5xl font-semibold">TopFadeGrid</h1>
      </TopFadeGrid>
    </>
  )
}
