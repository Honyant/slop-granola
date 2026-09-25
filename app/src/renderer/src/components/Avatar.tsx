import styles from './Avatar.module.css'

/** Granola's letter-avatar palette (background, letter), measured from the app. */
const PALETTE: readonly [string, string][] = [
  ['#3e361e', '#ebe2a9'],
  ['#83512c', '#fcebae'],
  ['#53448d', '#e8e4f2'],
  ['#973461', '#fadff5'],
  ['#4049b2', '#d6e4f6'],
  ['#4e4d4b', '#acada9'],
]

export function paletteFor(seed: string): [string, string] {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return PALETTE[hash % PALETTE.length]!
}

interface AvatarProps {
  name: string
  seed?: string
  src?: string | null
  size?: number
  shape?: 'circle' | 'square'
}

export function Avatar({ name, seed, src, size = 32, shape = 'circle' }: AvatarProps) {
  const [background, color] = paletteFor((seed ?? name).toLowerCase())
  const radius = shape === 'circle' ? '50%' : `${Math.round(size * 0.22)}px`
  if (src) {
    return <img className={styles.avatar} src={src} alt="" style={{ width: size, height: size, borderRadius: radius }} />
  }
  return (
    <span
      className={styles.avatar}
      aria-hidden
      style={{ width: size, height: size, borderRadius: radius, background, color, fontSize: size * 0.56 }}
    >
      {initial(name)}
    </span>
  )
}

function initial(name: string): string {
  return (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()
}
