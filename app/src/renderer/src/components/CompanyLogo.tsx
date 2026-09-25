import { useState } from 'react'
import { Avatar } from './Avatar'

/**
 * A company's own icon, fetched from its domain (touch icon first: it is large
 * enough for a 32px tile; favicon second), falling back to a letter tile.
 * Fetching from the domain itself rather than a favicon service means no third
 * party learns which companies the user meets with.
 */
export function CompanyLogo({ domain, name, size }: { domain: string; name: string; size: number }) {
  const sources = [`https://${domain}/apple-touch-icon.png`, `https://${domain}/favicon.ico`]
  const [attempt, setAttempt] = useState(0)
  if (attempt >= sources.length) return <Avatar name={name} seed={domain} size={size} shape="square" />
  return (
    <img
      src={sources[attempt]}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      style={{ borderRadius: Math.round(size * 0.22), objectFit: 'cover', flex: 'none', background: '#fff' }}
      onError={() => setAttempt((a) => a + 1)}
    />
  )
}
