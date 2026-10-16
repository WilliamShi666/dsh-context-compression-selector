import type { ReactNode } from 'react'

interface MenuItem {
  id: string
  label: ReactNode
}

interface MenuProps {
  anchor: ReactNode
  items: readonly MenuItem[]
  onSelect: (id: string) => void
  open: boolean
}

/**
 * Chevron artwork under BOTH generations' export names.
 *
 * The component resolves the glyph by reading the package namespace, because
 * neither name compiles against the other generation's types: 0.1.x exports
 * `IconChevronDownOutline14` and 0.2.0 renamed the same artwork to
 * `IconChevronDownOutlineRegular`. `IconProps` is identical on both, so this
 * stub exposes both names, exactly as a real installation would expose one.
 */
export function IconChevronDownOutlineRegular({ className }: { className?: string }) {
  return <span aria-hidden="true" className={className}>⌄</span>
}

/** 0.1.x name for the artwork above; the runtime picks whichever exists. */
export function IconChevronDownOutline14({ className }: { className?: string }) {
  return <span aria-hidden="true" className={className}>⌄</span>
}

export function Menu({ anchor, items, onSelect, open }: MenuProps) {
  return (
    <>
      {anchor}
      {open ? (
        <div role="menu">
          {items.map(item => (
            <button key={item.id} role="menuitem" type="button" onClick={() => { onSelect(item.id) }}>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  )
}
