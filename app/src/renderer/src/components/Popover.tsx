import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import styles from './Popover.module.css'

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'left-start'

interface PopoverProps {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose(): void
  placement?: Placement
  offset?: number
  className?: string
  children: ReactNode
}

const MARGIN = 8

/**
 * Floating layer anchored to an element. Positioned once on open (menus do
 * not follow scroll; they close instead), flipped to stay inside the window,
 * dismissed by outside press, Escape, scroll or resize.
 */
export function Popover({ anchor, open, onClose, placement = 'bottom-start', offset = 6, className, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor.current || !ref.current) {
      setPosition(null)
      return
    }
    setPosition(place(anchor.current.getBoundingClientRect(), ref.current.getBoundingClientRect(), placement, offset))
  }, [open, anchor, placement, offset])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!ref.current?.contains(target) && !anchor.current?.contains(target)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    const onScroll = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [open, onClose, anchor])

  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      className={`${styles.popover} ${className ?? ''}`}
      style={position ? { top: position.top, left: position.left } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  )
}

function place(a: DOMRect, p: DOMRect, placement: Placement, offset: number): { top: number; left: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let top: number
  let left: number
  switch (placement) {
    case 'bottom-start':
    case 'bottom-end':
      top = a.bottom + offset
      if (top + p.height > vh - MARGIN && a.top - offset - p.height > MARGIN) top = a.top - offset - p.height
      left = placement === 'bottom-start' ? a.left : a.right - p.width
      break
    case 'top-start':
    case 'top-end':
      top = a.top - offset - p.height
      if (top < MARGIN) top = a.bottom + offset
      left = placement === 'top-start' ? a.left : a.right - p.width
      break
    case 'right-start':
      top = a.top
      left = a.right + offset
      break
    case 'left-start':
      top = a.top
      left = a.left - offset - p.width
      break
  }
  return {
    top: Math.max(MARGIN, Math.min(top, vh - p.height - MARGIN)),
    left: Math.max(MARGIN, Math.min(left, vw - p.width - MARGIN)),
  }
}

interface MenuItemProps {
  icon?: ReactNode
  children: ReactNode
  trailing?: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect?(): void
}

export function MenuItem({ icon, children, trailing, danger, disabled, onSelect }: MenuItemProps) {
  return (
    <button type="button" role="menuitem" className={styles.item} data-danger={danger || undefined} disabled={disabled} onClick={onSelect}>
      {icon && <span className={styles.icon}>{icon}</span>}
      <span className={styles.label}>{children}</span>
      {trailing && <span className={styles.trailing}>{trailing}</span>}
    </button>
  )
}

export const MenuSeparator = () => <div className={styles.separator} role="separator" />
