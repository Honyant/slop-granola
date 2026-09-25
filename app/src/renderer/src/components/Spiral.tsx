/** Granola-style spiral mark, drawn as an Archimedean spiral path. */
export function Spiral({ size = 16, color = 'currentColor', strokeWidth = 2.2 }: { size?: number; color?: string; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d={SPIRAL_PATH} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  )
}

const SPIRAL_PATH = (() => {
  const turns = 2.6
  const steps = 120
  const points: string[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const theta = t * turns * 2 * Math.PI - Math.PI / 2
    const r = 9.6 * (0.08 + 0.92 * t)
    points.push(`${(12 + r * Math.cos(theta)).toFixed(2)} ${(12 + r * Math.sin(theta)).toFixed(2)}`)
  }
  return `M${points.join(' L')}`
})()
