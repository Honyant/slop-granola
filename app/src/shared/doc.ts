// Pure conversions between TipTap/ProseMirror JSON and Markdown. Used by search
// indexing, to feed the user's own notes to the LLM, and to load enhanced notes
// into the editor, so it lives outside the editor.
import { Marked } from 'marked'
import type { DocJSON } from './types'

interface PMNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  content?: PMNode[]
}

export const EMPTY_DOC: DocJSON = { type: 'doc', content: [{ type: 'paragraph' }] }

export function docToMarkdown(doc: DocJSON | null | undefined): string {
  if (!doc?.content) return ''
  return blocks(doc.content as PMNode[], '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function docToText(doc: DocJSON | null | undefined): string {
  return docToMarkdown(doc)
    .replace(/^#+[ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-*]|\d+\.)[ \t]+(?:\[[ x]\][ \t]+)?/gm, '')
    .replace(/[*_`~]/g, '')
}

function blocks(nodes: PMNode[], indent: string): string {
  return nodes.map((node) => block(node, indent)).join('')
}

function block(node: PMNode, indent: string): string {
  switch (node.type) {
    case 'paragraph':
      return `${indent}${inline(node.content)}\n\n`
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6)
      return `${'#'.repeat(level)} ${inline(node.content)}\n\n`
    }
    case 'bulletList':
      return listItems(node, indent, () => '- ') + (indent ? '' : '\n')
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      return listItems(node, indent, (i) => `${start + i}. `) + (indent ? '' : '\n')
    }
    case 'taskList':
      return listItems(node, indent, (_i, item) => `- [${item.attrs?.checked ? 'x' : ' '}] `) + (indent ? '' : '\n')
    case 'blockquote':
      return blocks(node.content ?? [], indent)
        .split('\n')
        .map((line) => (line ? `> ${line}` : line))
        .join('\n')
    case 'codeBlock':
      return `\`\`\`\n${inline(node.content)}\n\`\`\`\n\n`
    case 'horizontalRule':
      return '---\n\n'
    default:
      return node.content ? blocks(node.content, indent) : ''
  }
}

function listItems(list: PMNode, indent: string, marker: (index: number, item: PMNode) => string): string {
  return (list.content ?? [])
    .map((item, i) => {
      const [first, ...rest] = item.content ?? []
      const head = first ? inline(first.content) : ''
      const nested = rest.map((child) => block(child, `${indent}  `)).join('')
      return `${indent}${marker(i, item)}${head}\n${nested}`
    })
    .join('')
}

function inline(nodes: PMNode[] | undefined): string {
  if (!nodes) return ''
  return nodes
    .map((node) => {
      if (node.type === 'hardBreak') return '\n'
      if (node.type !== 'text' || !node.text) return ''
      let text = node.text
      for (const mark of node.marks ?? []) {
        if (mark.type === 'bold') text = `**${text}**`
        else if (mark.type === 'italic') text = `*${text}*`
        else if (mark.type === 'code') text = `\`${text}\``
        else if (mark.type === 'strike') text = `~~${text}~~`
      }
      return text
    })
    .join('')
}

/**
 * Markdown to HTML the editor can load. GFM task items ("- [ ] Owner: task", which the
 * enhancement prompt asks for) become TipTap task lists; marked's default checkbox
 * inputs would be dropped by the editor's schema, losing the checkboxes.
 */
const editorMarkdown = new Marked({
  renderer: {
    list(token) {
      if (!token.items.every((item) => item.task)) return false
      const items = token.items.map(
        (item) =>
          `<li data-type="taskItem" data-checked="${item.checked ? 'true' : 'false'}">${this.parser.parse(item.tokens.filter((t) => t.type !== 'checkbox'))}</li>`,
      )
      return `<ul data-type="taskList">\n${items.join('\n')}\n</ul>\n`
    },
  },
})

export function markdownToEditorHtml(markdown: string): string {
  return editorMarkdown.parse(markdown, { async: false })
}
