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
