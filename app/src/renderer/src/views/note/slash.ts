// "/" in the notepad opens the template menu. The TipTap suggestion plugin
// owns matching and keyboard capture; its lifecycle is mirrored into a tiny
// store so a React component can render the menu.
import { Extension, type Editor, type Range } from '@tiptap/react'
import { Suggestion } from '@tiptap/suggestion'
import { create } from 'zustand'
import type { Template } from '@shared/types'

interface SlashState {
  open: boolean
  items: Template[]
  selected: number
  rect: DOMRect | null
  choose: ((template: Template) => void) | null
}

export const useSlash = create<SlashState>(() => ({ open: false, items: [], selected: 0, rect: null, choose: null }))

export function createSlashExtension(templates: () => Template[], onChoose: (template: Template) => void) {
  return Extension.create({
    name: 'slashTemplates',
    addProseMirrorPlugins() {
      return [
        Suggestion<Template, Template>({
          editor: this.editor,
          char: '/',
          startOfLine: false,
          items: ({ query }) =>
            templates()
              .filter((t) => t.name.toLowerCase().includes(query.toLowerCase()))
              .slice(0, 8),
          command: ({ editor, range, props }) => {
            insertTemplate(editor, range, props)
            onChoose(props)
          },
          render: () => ({
            onStart: (props) =>
              useSlash.setState({
                open: true,
                items: props.items,
                selected: 0,
                rect: props.clientRect?.() ?? null,
                choose: (t) => props.command(t),
              }),
            onUpdate: (props) =>
              useSlash.setState({
                items: props.items,
                selected: 0,
                rect: props.clientRect?.() ?? null,
                choose: (t) => props.command(t),
              }),
            onKeyDown: ({ event }) => {
              const { items, selected, choose, open } = useSlash.getState()
              if (!open) return false
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                const delta = event.key === 'ArrowDown' ? 1 : -1
                useSlash.setState({ selected: (selected + delta + items.length) % Math.max(items.length, 1) })
                return true
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                const item = items[selected]
                if (item && choose) choose(item)
                return item !== undefined
              }
              if (event.key === 'Escape') {
                useSlash.setState({ open: false })
                return true
              }
              return false
            },
            onExit: () => useSlash.setState({ open: false, choose: null }),
          }),
        }),
      ]
    },
  })
}

/**
 * Replaces "/query" with the template's section headings. The template's
 * guidance lines (in parentheses) are for the AI, not the notepad.
 */
function insertTemplate(editor: Editor, range: Range, template: Template): void {
  const headings = template.body
    .split('\n')
    .map((line) => /^#{1,6}\s+(.*)$/.exec(line)?.[1]?.trim())
    .filter((h): h is string => !!h)
  const content = headings.flatMap((text) => [
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
  ])
  editor.chain().focus().deleteRange(range).insertContent(content).run()
}
