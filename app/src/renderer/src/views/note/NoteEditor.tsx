import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorContent, useEditor, type Content, type Extensions } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { FileText } from 'lucide-react'
import type { DocJSON, Template } from '@shared/types'
import { createSlashExtension, useSlash } from './slash'
import styles from './NoteEditor.module.css'

interface NoteEditorProps {
  /** Initial content; the editor is uncontrolled after mount (keyed by note). */
  content: DocJSON | string
  placeholder: string
  onChange(doc: DocJSON): void
  templates?: Template[]
  onTemplate?(template: Template): void
  editable?: boolean
}

export function NoteEditor({ content, placeholder, onChange, templates, onTemplate, editable = true }: NoteEditorProps) {
  const latest = useRef({ onChange, templates, onTemplate })
  latest.current = { onChange, templates, onTemplate }

  // Extensions are fixed for the editor's lifetime; callbacks go through `latest`.
  const [extensions] = useState<Extensions>(() => {
    const list: Extensions = [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: true, autolink: true },
      }),
      Placeholder.configure({ placeholder }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ]
    if (latest.current.templates) {
      list.push(
        createSlashExtension(
          () => latest.current.templates ?? [],
          (t) => latest.current.onTemplate?.(t),
        ),
      )
    }
    return list
  })

  const editor = useEditor({
    extensions,
    // DocJSON is opaque everywhere else; the editor is the one place that interprets it.
    content: content as Content,
    editable,
    editorProps: { attributes: { class: styles.prose!, spellcheck: 'true' } },
    onUpdate: ({ editor }) => latest.current.onChange(editor.getJSON() as DocJSON),
  })

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  return (
    <>
      <EditorContent editor={editor} className={styles.editor} />
      <SlashMenu />
    </>
  )
}

function SlashMenu() {
  const { open, items, selected, rect, choose } = useSlash()
  if (!open || !rect) return null
  return createPortal(
    <div className={styles.slash} style={{ top: rect.bottom + 6, left: rect.left }} role="listbox" aria-label="Templates">
      <div className={styles.slashHeading}>Templates</div>
      {items.length === 0 && <div className={styles.slashEmpty}>No matching templates</div>}
      {items.map((t, i) => (
        <button
          key={t.id}
          type="button"
          role="option"
          aria-selected={i === selected}
          className={styles.slashItem}
          onMouseDown={(e) => {
            e.preventDefault()
            choose?.(t)
          }}
          onMouseEnter={() => useSlash.setState({ selected: i })}
        >
          <FileText size={15} strokeWidth={1.7} />
          <span className={styles.slashName}>{t.name}</span>
          <span className={styles.slashDescription}>{t.description}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
