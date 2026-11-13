/** Bounded text views shared by session inspection and peer message previews. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Preview joined text blocks without copying message bodies beyond the display bound. */
export function textPreview(content: readonly ContentBlock[], max: number, separator: ' ' | '\n' = ' '): { text: string; truncated?: true; fullLength?: number } {
  let text = ''
  let fullLength = 0
  let blocks = 0
  for (const block of content) {
    if (block.type !== 'text') continue
    if (blocks++ > 0) {
      fullLength++
      if (text.length < max) text += separator
    }
    fullLength += block.text.length
    if (text.length < max) text += block.text.slice(0, max - text.length)
  }
  if (fullLength <= max) return { text }
  const last = text.charCodeAt(text.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
  return { text, truncated: true, fullLength }
}
