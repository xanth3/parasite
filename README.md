# Parasite

A Windows x64 desktop app (Electron — same stack as Discord) for tracking, previewing, upscaling, clipping, and exporting recorded/downloaded video. Built for clip farmers who move fast over 12-hour VODs.

## Features

### Core
- **Library with two tabs: Clips and Unedited.** Anything under 30 minutes lands in Clips, 30 min+ in Unedited. Threshold is configurable.
- **Scrubbing video viewer** — fine for 12-hour files (native HTML5 `<video>` seek).
- **Google Drive upload** with live progress bar. Files go to a default folder Parasite creates once.
- **Inline rename** from the preview pane.
- **Export to YouTube / TikTok / Instagram / Twitter (X)** with a punchy title suggestion.
- **Record Stream** tab: Twitch (zackrawrr, lirik) or Kick → drives OBS to Window-Capture-record into Unedited.
- **Live Whisper transcription** (offline, `whisper-node` / whisper.cpp) — streams into UI and a `.txt` file.
- Discord-inspired dark UI.

### Clip-farming features
- **Chat-based heatmap scrubber.** While recording, Parasite connects anonymously to Twitch IRC / Kick Pusher chat. Spam patterns (`LUL`, `POG`, `W`, `KEKW`, all-caps, etc.) get bucketed into a JSON heatmap saved next to the video. The scrubber renders a red-hot overlay so you jump straight to the spikes instead of scrubbing 12 hours.
- **Ghost Clipping (zero re-encode).** Mark an In and Out point, hit Ghost Clip → `ffmpeg -c copy` slices the range instantly. A 30s clip out of a 50GB VOD completes in ~1s with no quality loss.
- **9:16 Vertical Preview.** Toggle the crop overlay, drag the yellow box onto the streamer's face, then pick `Export → TikTok` — Parasite re-encodes only the In→Out range with your crop baked in and uploads it.
- **Batch Queue.** Tag multiple clips for Drive/YouTube/TikTok/etc., hit `Queue it`, walk away. The queue is persisted in SQLite and resumes if you close the app mid-upload.
- **Global Hotkey `Ctrl+Shift+X`.** While watching a stream or playing, hit the hotkey — Parasite captures a timestamp. When the recording stops, those flags attach to the saved file and show as little yellow flags on the scrubber.

### Performance
- **SQLite index.** Videos, flags, and the queue live in a WAL-mode SQLite database. Library opens instantly even with 10TB of footage; only changed files get re-probed with ffprobe.
- **Virtualized file list.** Custom vanilla-JS virtual list (`src/lib-ui/vlist.js`) — Unedited can hold 10k rows without dropping frames.
- **GPU hints for Electron.** `enable-gpu-rasterization`, `enable-accelerated-video-decode`, and `backgroundThrottling: false` so the video player stays smooth during Drive uploads.

### Crash reporting
- Uncaught exceptions (main + renderer) open a dedicated crash screen with:
  - A plain-English guess of what probably went wrong (network? missing file? OBS dropped?).
  - A hidden technical report.
  - A **Send Feedback** button that opens the user's mail client with the full report pre-filled to `noreply@parasitebrands.com`.
- Native crashes (segfaults, etc.) also write minidumps via Electron's built-in `crashReporter`.

## Install & run (dev)

Requires Node.js 20+ and Windows x64.

```powershell
cd Parasite
npm install
npm start
```

## Build a Windows installer

```powershell
npm run dist
# → dist\Parasite-Setup-0.1.0.exe
```

The NSIS installer is branded with the Parasite icon (`build/icon.ico`) and
ships a header + sidebar bitmap. It is a **non-one-click** installer that lets
the user pick install location, creates Desktop + Start Menu shortcuts, and
runs the app automatically on finish. Reinstalling on top of a prior install
preserves your library, queue, and tokens (`deleteAppDataOnUninstall: false`).

## First-time setup

1. **Library folder** — defaults to `%USERPROFILE%\Videos\Parasite`. Change in Settings.
2. **Google Drive** — Desktop OAuth client → paste Client ID/Secret → Connect → paste code.
3. **OBS** — install OBS 28+, enable WebSocket server, create scene `Parasite Stream` with source `Parasite Window Capture`.
4. **Whisper** — toggle Enable, pick model. First run downloads the model (~150MB for `base.en`).
5. **Exports** — paste credentials per platform (one-time).
6. **Hotkey** — defaults to `Control+Shift+X`, re-bind in Settings → Hotkeys.

## Workflow (clip farmer happy path)

1. **Record Stream → Twitch → zackrawrr → Start Recording.** OBS starts writing to Unedited; chat heatmap + transcript stream live.
2. **Watching the VOD live? Hit `Ctrl+Shift+X`** when something happens. Flag captured.
3. **Stop Recording.** Heatmap JSON + flags attach to the saved video.
4. **Library → Unedited → click the file.** Red spikes appear on the scrubber. Click the hottest one.
5. **Mark In** / **Mark Out** → **Ghost Clip.** 30s clip in <1s.
6. **Hit 9:16 Preview**, drag the crop onto the streamer's face.
7. **Export → TikTok**, write the hook, hit **Queue it**. Move on to the next clip.
8. **Queue tab** shows everything uploading in the background.

## Project layout

```
Parasite/
├── package.json
├── main.js
├── preload.js
└── src/
    ├── index.html
    ├── styles.css
    ├── renderer.js
    ├── crash.html
    ├── tabs/
    │   ├── library.js      # list + preview + heatmap + in/out + ghost + vertical + export
    │   ├── record.js       # channel picker + live heatmap + transcript
    │   ├── queue.js        # batch queue UI
    │   └── settings.js     # all configuration UI
    ├── lib-ui/
    │   └── vlist.js        # virtualized list (renderer-only)
    └── lib/
        ├── db.js           # better-sqlite3 index
        ├── drive.js        # Google Drive OAuth + resumable upload
        ├── obs.js          # OBS WebSocket
        ├── chat.js         # Twitch IRC + Kick Pusher → heatmap buckets
        ├── clip.js         # ffmpeg stream-copy + vertical crop
        ├── queue.js        # persistent batch processor
        ├── whisper.js      # ffmpeg → 5s WAV chunks → whisper-node
        ├── export.js       # YouTube / TikTok / Instagram / Twitter adapters
        └── crash.js        # crash reporter
```

## License

MIT
