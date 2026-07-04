/**
 * EaseCutPro MCP server — lets Claude (Desktop / Claude Code) edit videos in the
 * EaseCutPro project library. Claude calls these tools; the edits are written to
 * the SAME project files the desktop editor opens (~/.easecutpro/projects), so
 * you can open the project in the editor to preview / fine-tune Claude's work.
 *
 * Run:  npx tsx src/mcp/index.ts   (configured as an MCP server in Claude)
 */
import { mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import {
  defaultProjectsRoot,
  listProjectRecords,
  createProjectRecord,
  getProjectRecord,
  saveProjectRecord
} from '../main/projectStore'
import { probe, detectSilence, exportProject } from '../main/ffmpeg'
import { transcribe as runTranscribe } from '../main/whisper'
import { computeKeepRanges, editedDuration } from '../shared/edit'
import { detectCleanupIds, DEFAULT_FILLERS } from '../shared/fillers'
import { createEmptyProject, newTextId, newClipId } from '../shared/project'
import type { Project, Transcript, TextClip, Clip } from '../shared/types'

// ---- Active project (held in memory across tool calls) ----
let activeId: string | null = null
let activeProject: Project | null = null
let activeName = ''

function requireActive(): Project {
  if (!activeProject) throw new Error('No active project. Call create_project or open_project first.')
  return activeProject
}
async function persist(): Promise<void> {
  if (activeId && activeProject) {
    activeProject.name = activeName
    await saveProjectRecord(activeId, { project: activeProject, name: activeName })
  }
}
const ok = (text: string): { content: { type: 'text'; text: string }[] } => ({ content: [{ type: 'text', text }] })

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9']/g, '')
const tokens = (s: string): string[] => s.split(/\s+/).map(norm).filter(Boolean)

/** Set/clear the deleted flag on words by id, in BOTH the flat list and segments. */
function markDeleted(t: Transcript, ids: Set<string>, deleted = true): void {
  for (const w of t.words) if (ids.has(w.id)) w.deleted = deleted
  for (const s of t.segments) for (const w of s.words) if (ids.has(w.id)) w.deleted = deleted
}

/** Word ids whose text matches the given phrase (every occurrence). */
function idsMatchingText(t: Transcript, phrase: string): Set<string> {
  const target = tokens(phrase)
  const ids = new Set<string>()
  if (!target.length) return ids
  const words = t.words
  for (let i = 0; i + target.length <= words.length; i++) {
    let m = true
    for (let k = 0; k < target.length; k++) if (norm(words[i + k].text) !== target[k]) { m = false; break }
    if (m) {
      for (let k = 0; k < target.length; k++) ids.add(words[i + k].id)
      i += target.length - 1
    }
  }
  return ids
}

function summary(p: Project): string {
  const src = p.media?.duration ?? 0
  const edited = editedDuration(p)
  const kept = computeKeepRanges(p).length
  const deleted = p.transcript ? p.transcript.words.filter((w) => w.deleted).length : 0
  const overlays = p.tracks.flatMap((t) => t.clips).length
  return [
    `Media: ${p.media?.path ?? '(none)'}${p.media ? ` — ${src.toFixed(1)}s, ${p.media.width}x${p.media.height}` : ''}`,
    `Edited length: ${edited.toFixed(1)}s (${kept} kept segment${kept === 1 ? '' : 's'})`,
    `Transcript: ${p.transcript ? `${p.transcript.words.length} words, ${deleted} deleted` : 'not transcribed'}`,
    `Silences removed: ${p.silences.filter((s) => s.action === 'remove').length} · Text overlays: ${p.texts?.length ?? 0} · B-roll clips: ${overlays}`
  ].join('\n')
}

// ---- Server ----
const server = new McpServer({ name: 'easecutpro', version: '1.0.0' })

server.tool('list_projects', 'List the saved EaseCutPro projects (name + id).', {}, async () => {
  const list = await listProjectRecords()
  if (!list.length) return ok('No projects yet. Use create_project to start one.')
  return ok(
    list
      .map((p) => `• ${p.name} — id: ${p.id} (updated ${new Date(p.updatedAt).toLocaleString()})`)
      .join('\n')
  )
})

server.tool(
  'create_project',
  'Create a new empty project and make it the active project for editing.',
  { name: z.string().describe('A name for the project') },
  async ({ name }) => {
    const project = createEmptyProject(name)
    const rec = await createProjectRecord(name, project)
    activeId = rec.id
    activeProject = project
    activeName = name
    return ok(`Created "${name}" (id: ${rec.id}) and made it active. Next: set_video.`)
  }
)

server.tool(
  'open_project',
  'Open an existing project by id and make it the active project.',
  { id: z.string() },
  async ({ id }) => {
    const rec = await getProjectRecord(id)
    if (!rec) throw new Error('Project not found: ' + id)
    activeId = rec.id
    activeProject = rec.project ?? createEmptyProject(rec.name)
    activeName = rec.name
    return ok(`Opened "${rec.name}".\n${summary(activeProject)}`)
  }
)

server.tool(
  'set_video',
  'Set the main (base) video or audio for the active project from a local file path. Resets prior edits on the base.',
  { path: z.string().describe('Absolute path to a local video/audio file on this machine') },
  async ({ path: p }) => {
    requireActive()
    const media = await probe(p)
    activeProject = { ...createEmptyProject(activeName), media }
    await persist()
    return ok(
      `Base media set: ${p}\n${media.duration.toFixed(1)}s · ${media.width}x${media.height} · ${media.hasAudio ? 'has audio' : 'no audio'}.\nNext: transcribe (to cut by words) and/or remove_silence.`
    )
  }
)

server.tool(
  'transcribe',
  'Transcribe the active video\'s audio offline (whisper.cpp, GPU-accelerated). Required before cutting by words/sentences.',
  {},
  async () => {
    const project = requireActive()
    if (!project.media?.path) throw new Error('No video set. Call set_video first.')
    const transcript: Transcript = await runTranscribe(project.media.path)
    project.transcript = transcript
    await persist()
    const preview = transcript.segments.slice(0, 8).map((s) => s.words.map((w) => w.text).join(' ')).join('\n')
    return ok(`Transcribed ${transcript.words.length} words in ${transcript.segments.length} sentences.\n\nFirst lines:\n${preview}\n\nUse get_transcript to see all, then delete_text / remove_fillers to cut.`)
  }
)

server.tool(
  'get_transcript',
  'Get the transcript as numbered sentences with timestamps. Deleted words are shown ~~struck~~.',
  {},
  async () => {
    const project = requireActive()
    const t = project.transcript
    if (!t) throw new Error('Not transcribed yet — call transcribe first.')
    const lines = t.segments.map((s, i) => {
      const text = s.words.map((w) => (w.deleted ? `~~${w.text}~~` : w.text)).join(' ')
      return `${i}. [${s.start.toFixed(1)}s] ${text}`
    })
    return ok(lines.join('\n') || '(empty transcript)')
  }
)

server.tool(
  'delete_text',
  'Cut every occurrence of the given text from the video (marks those words deleted). Case-insensitive — give a word, phrase, or whole sentence.',
  { text: z.string() },
  async ({ text }) => {
    const project = requireActive()
    const t = project.transcript
    if (!t) throw new Error('Transcribe first.')
    const ids = idsMatchingText(t, text)
    markDeleted(t, ids)
    await persist()
    return ok(ids.size ? `Cut ${ids.size} word(s) matching "${text}". Edited length now ${editedDuration(project).toFixed(1)}s.` : `No match for "${text}".`)
  }
)

server.tool(
  'restore_text',
  'Restore (un-delete) every occurrence of the given text.',
  { text: z.string() },
  async ({ text }) => {
    const project = requireActive()
    const t = project.transcript
    if (!t) throw new Error('Transcribe first.')
    const ids = idsMatchingText(t, text)
    markDeleted(t, ids, false)
    await persist()
    return ok(`Restored ${ids.size} word(s) matching "${text}".`)
  }
)

server.tool(
  'remove_fillers',
  'Detect and cut filler words (um/uh/like…), stutters, restarted phrases, and repeated sentences.',
  {},
  async () => {
    const project = requireActive()
    const t = project.transcript
    if (!t) throw new Error('Transcribe first.')
    const ids = new Set(detectCleanupIds(t, DEFAULT_FILLERS))
    markDeleted(t, ids)
    await persist()
    return ok(`Removed ${ids.size} filler/repeat word(s). Edited length now ${editedDuration(project).toFixed(1)}s.`)
  }
)

server.tool(
  'remove_silence',
  'Detect and remove silent gaps from the video.',
  {
    thresholdDb: z.number().optional().describe('Silence threshold in dB (default -30; lower = stricter)'),
    minDuration: z.number().optional().describe('Minimum gap length in seconds to remove (default 0.4)')
  },
  async ({ thresholdDb, minDuration }) => {
    const project = requireActive()
    if (!project.media?.path) throw new Error('No video set.')
    const regions = await detectSilence(project.media.path, {
      noiseDb: thresholdDb ?? -30,
      minDuration: minDuration ?? 0.4
    })
    project.silences = regions.map((r) => ({ ...r, action: 'remove' as const }))
    await persist()
    const saved = regions.reduce((s, r) => s + (r.end - r.start), 0)
    return ok(`Removed ${regions.length} silent gap(s) (~${saved.toFixed(1)}s). Edited length now ${editedDuration(project).toFixed(1)}s.`)
  }
)

server.tool(
  'add_text',
  'Add an on-screen text overlay. (Note: text is baked when you export from the EDITOR; MCP export does not render text yet.)',
  {
    text: z.string(),
    start: z.number().describe('start time in seconds'),
    end: z.number().describe('end time in seconds'),
    x: z.number().optional().describe('horizontal center 0..1 (default 0.5)'),
    y: z.number().optional().describe('vertical center 0..1 (default 0.8)')
  },
  async ({ text, start, end, x, y }) => {
    const project = requireActive()
    const tc: TextClip = {
      id: newTextId(),
      text,
      start,
      end: Math.max(start + 0.3, end),
      x: x ?? 0.5,
      y: y ?? 0.8,
      fontFamily: 'Arial Black',
      fontSize: 0.08,
      color: '#ffffff',
      align: 'center',
      bold: true,
      italic: false,
      strokeWidth: 0.06,
      strokeColor: '#000000',
      bgEnabled: false,
      bgColor: '#000000',
      bgRadius: 0.3,
      bgPadding: 0.3,
      bgOpacity: 0.6
    }
    project.texts = [...(project.texts ?? []), tc]
    await persist()
    return ok(`Added text "${text}" from ${start}s–${end}s.`)
  }
)

server.tool(
  'add_broll',
  'Overlay a b-roll clip (video or image) on top of the base video at a given time.',
  {
    path: z.string().describe('Absolute path to a local video/image'),
    start: z.number().describe('when it appears on the timeline (seconds)'),
    trackIndex: z.number().optional().describe('overlay track 1 or 2 (default 1)')
  },
  async ({ path: p, start, trackIndex }) => {
    const project = requireActive()
    const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(p)
    let info: Awaited<ReturnType<typeof probe>> | null = null
    try {
      info = await probe(p)
    } catch {
      /* images may not probe */
    }
    const dur = isImage ? 5 : info?.duration || 5
    const idx = trackIndex === 2 ? 2 : 1
    const clip: Clip = {
      id: newClipId(),
      name: p.split(/[\\/]/).pop() ?? 'b-roll',
      sourcePath: p,
      sourceIn: 0,
      sourceOut: dur,
      sourceDuration: isImage ? 3600 : info?.duration || dur,
      isImage,
      srcW: info?.width || 1920,
      srcH: info?.height || 1080,
      start,
      x: 0.28,
      y: 0.28,
      scale: 0.45,
      crop: { l: 0, t: 0, r: 0, b: 0 },
      zoomStart: 1,
      zoomEnd: 1
    }
    project.tracks = project.tracks.map((t) => (t.index === idx ? { ...t, clips: [...t.clips, clip] } : t))
    await persist()
    return ok(`Added b-roll "${clip.name}" on overlay ${idx} at ${start}s.`)
  }
)

server.tool(
  'set_base_zoom',
  'Add a Ken Burns zoom on the base video for a time range (1 = 100%, 1.3 = 130%).',
  { start: z.number(), end: z.number(), zoomStart: z.number(), zoomEnd: z.number() },
  async ({ start, end, zoomStart, zoomEnd }) => {
    const project = requireActive()
    const rest = (project.baseZooms ?? []).filter(
      (z) => Math.abs(z.start - start) > 0.03 || Math.abs(z.end - end) > 0.03
    )
    project.baseZooms = [...rest, { start, end, zoomStart: Math.max(1, zoomStart), zoomEnd: Math.max(1, zoomEnd) }]
    await persist()
    return ok(`Zoom ${Math.round(zoomStart * 100)}%→${Math.round(zoomEnd * 100)}% from ${start}s to ${end}s.`)
  }
)

server.tool('get_summary', 'Summary of the active project (durations, cuts, edits).', {}, async () => {
  return ok(summary(requireActive()))
})

server.tool(
  'export',
  'Render the active project to an mp4 and return the output path. NOTE: text overlays added via add_text are NOT baked here yet — open the project in the editor to export text.',
  {
    outPath: z.string().optional().describe('output .mp4 path (defaults to ~/.easecutpro/exports)'),
    width: z.number().optional(),
    height: z.number().optional(),
    bitrateMbps: z.number().optional()
  },
  async ({ outPath, width, height, bitrateMbps }) => {
    const project = requireActive()
    if (!project.media?.path) throw new Error('No video set.')
    const out =
      outPath ||
      join(defaultProjectsRoot(), 'exports', `${(activeName || 'export').replace(/[^\w.-]+/g, '_')}-${Date.now()}.mp4`)
    await mkdir(dirname(out), { recursive: true })
    await exportProject(project, out, { width: width || 0, height: height || 0, bitrateMbps: bitrateMbps || 0 }, [])
    return ok(`Exported to: ${out}`)
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
