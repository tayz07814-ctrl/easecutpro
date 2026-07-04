# Connect Claude to EaseCutPro (MCP)

EaseCutPro ships an **MCP server** so Claude (Claude Desktop or Claude Code) can
edit videos for you. Claude's edits are written to the **same project library
the desktop editor opens** (`~/.easecutpro/projects`), so you can open the
project in the editor afterward to preview and fine-tune.

## What Claude can do (the tools)

| Tool | What it does |
|------|--------------|
| `list_projects` / `create_project` / `open_project` | Manage the project library |
| `set_video` | Set the base video/audio from a local file path |
| `transcribe` | Offline transcription (whisper.cpp, **GPU-accelerated**) |
| `get_transcript` | Read the transcript (sentences + timestamps) |
| `delete_text` / `restore_text` | Cut / restore words, phrases, or whole sentences |
| `remove_fillers` | Cut um/uh/like, stutters, restarts, repeated sentences |
| `remove_silence` | Detect + remove silent gaps |
| `add_text` | Add an on-screen text overlay |
| `add_broll` | Overlay a b-roll clip/image |
| `set_base_zoom` | Ken Burns zoom on the base |
| `get_summary` | Project state (durations, cuts, edits) |
| `export` | Render to an mp4 |

## Set it up

### Claude Desktop
Edit your config file:
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "easecutpro": {
      "command": "npx",
      "args": ["tsx", "C:/easecutpro/src/mcp/index.ts"],
      "cwd": "C:/easecutpro"
    }
  }
}
```

Restart Claude Desktop. You'll see the EaseCutPro tools available.

### Claude Code (CLI)
```bash
claude mcp add easecutpro --cwd C:/easecutpro -- npx tsx C:/easecutpro/src/mcp/index.ts
```

## Use it

Just talk to Claude, e.g.:

> "Make a new project from `C:\videos\vlog.mp4`, transcribe it, remove all the
> filler words and silences, add the title 'My Day' for the first 3 seconds,
> then export it."

Claude will call the tools in order and tell you the output path. Open the
project in the EaseCutPro editor to preview or tweak.

## Notes / limits
- The MCP server runs **locally** and uses the same ffmpeg + whisper (and your
  **GPU**) the desktop app uses. No login — it's your machine, your files.
- It shares the **desktop** project library (`~/.easecutpro/projects`). The
  **web** version (accounts) is separate.
- **Text overlays are not yet baked in MCP `export`** — add them via `add_text`,
  but open the project in the **editor** and export there to render the text.
  (Cuts, silence removal, zoom, and b-roll all export fine from the MCP.)
