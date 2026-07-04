/**
 * Claude implementation of the Smart Cut request. Claude is best at the semantic
 * "the speaker re-recorded this take with different words" judgment when asked to
 * BRACKET the transcript (read it and wrap abandoned takes/repeats in `[…]`)
 * rather than emit indices — it never miscounts a flat numbered list. ai-cut.ts
 * parses the `[…]` spans and text-anchors them to word ids.
 */
import { getAnthropic } from './claude'

const MODEL = 'claude-opus-4-8'

/**
 * Send the raw window text; get it back VERBATIM with every abandoned attempt,
 * stumble, fragment, and repeated take wrapped in square brackets `[…]`, and only
 * the final clean take left outside. Returns the bracketed text (or '' on error).
 */
export async function requestCutsClaudeBracket(text: string, systemPrompt: string): Promise<string> {
  const client = getAnthropic()
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: text }]
  })
  const block = res.content.find((b) => b.type === 'text')
  return block && block.type === 'text' ? block.text : ''
}
