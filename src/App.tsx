import { Button, SegmentedControl, Slider, Switch } from 'glisse'
import { GradientGridRight, TopFadeGrid } from '@/components/ui/gradient-blur-bg'
import hero from '@/assets/hero.png'

export default function App() {
  return (
    <>
      <section
        data-glisse-backdrop
        className="flex min-h-[60vh] flex-col items-center justify-center gap-6 bg-cover bg-center p-16"
        style={{ backgroundImage: `url(${hero})` }}
      >
        <SegmentedControl
          aria-label="Range"
          defaultValue="week"
          items={[
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
          ]}
        />
        <Slider aria-label="Volume" defaultValue={50} className="w-64" />
        <div className="flex items-center gap-4">
          <Switch aria-label="Wi-Fi" defaultChecked />
          <Button>Glass</Button>
          <Button variant="filled">Continue</Button>
        </div>
      </section>
      <GradientGridRight>
        <h1 className="relative z-10 p-16 text-5xl font-semibold">GradientGridRight</h1>
      </GradientGridRight>
      <TopFadeGrid>
        <h1 className="relative z-10 p-16 text-5xl font-semibold">TopFadeGrid</h1>
      </TopFadeGrid>
    </>
  )
}
