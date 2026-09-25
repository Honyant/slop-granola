// Small shared controls: buttons, toggle, chip.
import type { ComponentProps, ReactNode } from 'react'
import styles from './controls.module.css'

type ButtonVariant = 'outline' | 'primary' | 'ghost' | 'soft' | 'accent'

interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant
  icon?: ReactNode
  size?: 'sm' | 'md'
}

export function Button({ variant = 'outline', icon, size = 'md', className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={`${styles.button} ${styles[variant]} ${styles[size]} ${className ?? ''}`} {...rest}>
      {icon}
      {children}
    </button>
  )
}

interface IconButtonProps extends ComponentProps<'button'> {
  label: string
  active?: boolean
  size?: number
}

export function IconButton({ label, active, size = 28, className, children, type = 'button', style, ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      data-active={active || undefined}
      className={`${styles.iconButton} ${className ?? ''}`}
      style={{ width: size, height: size, ...style }}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange(next: boolean): void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={styles.toggle}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.knob} />
    </button>
  )
}

export function Chip({ icon, children, onClick }: { icon?: ReactNode; children: ReactNode; onClick?(): void }) {
  return (
    <button type="button" className={styles.chip} onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  )
}
