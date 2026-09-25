/** Granola-style spiral mark, drawn as an Archimedean spiral path. */
export function Spiral({
  size = 16,
  color = 'currentColor',
  strokeWidth = 2.2,
  turns = 2.6,
}: {
  size?: number
  color?: string
  strokeWidth?: number
  /** Fewer turns read as the bolder app-icon mark at small sizes. */
  turns?: number
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d={spiralPath(turns)} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  )
}

const paths = new Map<number, string>()

function spiralPath(turns: number): string {
  let path = paths.get(turns)
  if (!path) {
    const steps = 120
    const points: string[] = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const theta = t * turns * 2 * Math.PI - Math.PI / 2
      const r = 9.6 * (0.08 + 0.92 * t)
      points.push(`${(12 + r * Math.cos(theta)).toFixed(2)} ${(12 + r * Math.sin(theta)).toFixed(2)}`)
    }
    path = `M${points.join(' L')}`
    paths.set(turns, path)
  }
  return path
}
