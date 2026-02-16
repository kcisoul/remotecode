# RemoteCode

Control [Claude Code](https://docs.anthropic.com/en/docs/claude-code) remotely through Telegram. Built specifically for Claude Code.

RemoteCode works directly with your local Claude Code -- same sessions, same project context, same history. Pick up where you left off in the terminal, switch projects, or start a new session, all from Telegram.

```
You (Anywhere)  <-->  RemoteCode (Host)  <-->  Claude Code (Host)
```

## Features

- **Text chat** -- Send any message, get Claude Code responses with Markdown formatting
- **Image analysis** -- Send photos or image documents, optionally with a caption prompt
- **Voice messages** -- Transcribed locally via whisper-cli (offline, free), then sent to Claude Code
- **Session management** -- Multiple sessions, switch between them, browse by project
- **Auto-sync** -- Watch active session files and forward new messages in real-time
- **Background daemon** -- Runs as a detached process with log rotation
- **User access control** -- Restrict access by Telegram user ID or username

## How It Works

```mermaid
sequenceDiagram
    participant U as You (Telegram)
    participant T as Telegram API
    participant D as RemoteCode Daemon
    participant C as Claude Code CLI

    U->>T: Send message
    T->>D: Long polling (getUpdates)
    D->>D: Auth check & route

    alt Text message
        D->>C: claude --resume <session> --print "prompt"
    else Image
        D->>T: Download file
        D->>C: claude --resume <session> --print "prompt + image path"
    else Voice
        D->>T: Download audio
        D->>D: ffmpeg + whisper-cli transcription
        D->>C: claude --resume <session> --print "transcription"
    end

    C-->>D: stdout response
    D->>D: Markdown → Telegram HTML
    D->>T: sendMessage (HTML)
    T-->>U: Formatted response
```

## Architecture

```mermaid
graph TB
    subgraph CLI["CLI (Terminal)"]
        IDX[index.ts<br/>arg parser]
        CL[cli.ts<br/>subcommands]
    end

    subgraph Daemon["Daemon Process"]
        DAE[daemon.ts<br/>poll loop + PID]
        HND[handler.ts<br/>message router]
        CMD[commands.ts<br/>slash commands]
        CB[callbacks.ts<br/>inline buttons]
        WAT[watcher.ts<br/>auto-sync]
    end

    subgraph Core["Core"]
        TEL[telegram.ts<br/>API client]
        CLA[claude.ts<br/>CLI spawner]
        SES[sessions.ts<br/>discovery + state]
        SUI[session-ui.ts<br/>UI formatting]
    end

    subgraph Shared["Shared"]
        CFG[config.ts<br/>paths + KV I/O]
        LOG[logger.ts<br/>logging]
        BAN[banner.ts<br/>terminal UI]
        CTX[context.ts<br/>auth + locks]
        FMT[format.ts<br/>MD → HTML]
    end

    IDX --> DAE
    IDX --> CL
    CL --> DAE
    DAE --> HND
    DAE --> CB
    HND --> CMD
    HND --> CLA
    HND --> CTX
    CB --> SES
    CB --> SUI
    CMD --> SUI
    WAT --> SES
    WAT --> CTX
    CLA --> LOG
    TEL --> LOG
    SUI --> FMT
    CL --> BAN
```

## Platform Support

| Platform | Status | Notes |
|---|---|---|
| **macOS** | Supported | Homebrew for STT dependencies |
| **Linux** | Supported | STT currently not supported |
| **Windows** | Not supported | |

## Quick Start

### Prerequisites

- **macOS** or **Linux**
- **Node.js** >= 18
- **Claude Code CLI** installed and authenticated (`claude` command available)
- **Telegram Bot Token** -- create a bot via [@BotFather](https://t.me/BotFather) on Telegram (send `/newbot`, follow the prompts, copy the token). See [Telegram's official guide](https://core.telegram.org/bots/tutorial#obtain-your-bot-token) for details

### Install

```bash
npm install -g @kcisoul/remotecode
```

Or from source:

```bash
git clone https://github.com/kcisoul/remotecode.git
cd remotecode
npm install && npm run build
npm link
```

### First Run

```bash
remotecode
```

The interactive setup wizard will prompt for:

1. **TELEGRAM_BOT_TOKEN** -- validated against Telegram API
2. **REMOTECODE_ALLOWED_USERS** -- comma-separated user IDs or @usernames
3. **REMOTECODE_YOLO** -- `Y` enables autonomous mode (Claude Code runs without permission prompts, required for full remote control). Set `N` if you prefer read-only / monitoring use, but note that any action requiring approval will block since there's no terminal to confirm
4. **STT setup** -- optional offline voice transcription. Installs `whisper-cli` and `ffmpeg` via your system's package manager, and downloads a local Whisper model (~466 MB). Runs entirely on your machine -- no API calls, completely free

Config is saved to `~/.remotecode/config`.

## CLI Commands

| Command | Description |
|---|---|
| `remotecode` | Start daemon (or show status if already running) |
| `remotecode start` | Start the background daemon |
| `remotecode stop` | Stop the daemon |
| `remotecode restart` | Restart the daemon |
| `remotecode status` | Show daemon status, active session, uptime |
| `remotecode logs` | Follow logs in real-time (default) |
| `remotecode logs -n 50` | Show last 50 log lines (static) |
| `remotecode logs --level ERROR` | Filter by log level (DEBUG/INFO/WARN/ERROR) |
| `remotecode logs --tag claude` | Filter by component tag |
| `remotecode config` | Edit configuration (auto-restarts daemon) |
| `remotecode setup-stt` | Install whisper-cli, ffmpeg, and download model |

### Flags

| Flag | Description |
|---|---|
| `-v`, `--verbose` | Enable verbose (DEBUG) logging |

## Telegram Commands

Send these as messages in your Telegram chat with the bot:

| Command | Description |
|---|---|
| `/start`, `/help` | Welcome message with quick action buttons |
| `/sessions` | Browse and switch between recent sessions |
| `/projects` | Browse sessions grouped by project directory |
| `/new` | Start a new Claude Code session |
| `/history` | Show conversation history of current session |
| `/sync` | Toggle auto-sync notifications on/off |

### Inline Buttons

After `/sessions` or `/projects`, interactive inline keyboards let you:

- **Switch** to any session with one tap
- **Create** new sessions (globally or per-project)
- **Delete** sessions
- **Navigate** between project views

## Message Types

### Text

Send any text message. If it's not a `/command`, it's forwarded to Claude Code as a prompt. Responses are rendered as Telegram HTML with code blocks, bold, italic, and more.

### Images

Send a photo or image document (PNG, JPG, etc.). The bot downloads the image, saves it to a temp directory, and includes the file path in the Claude Code prompt. Add a caption to provide context.

### Voice / Audio

Send a voice message or audio file. The bot:

1. Downloads the audio file
2. Converts to WAV via `ffmpeg`
3. Transcribes via `whisper-cli` (local, offline)
4. Sends the transcription as a prompt to Claude Code
5. Returns both your transcription and Claude's response in a blockquote

> Requires STT setup: `remotecode setup-stt`

## Session Management

```mermaid
stateDiagram-v2
    [*] --> NoSession: First message
    NoSession --> NewSession: auto-create UUID
    NewSession --> Active: claude --session-id
    Active --> Active: claude --resume
    Active --> Switched: /sessions or inline button
    Switched --> Active: select different session
    Active --> NewSession: /new
```

RemoteCode discovers sessions from `~/.claude/projects/*/` by scanning `.jsonl` files. Each session maps to a Claude Code conversation.

- **Active session** is stored in `~/.remotecode/local`
- **Session CWD** determines which directory Claude Code runs in
- Sessions are auto-created on first message if none exists
- The `--resume` flag is used to continue existing sessions; falls back to `--session-id` for new ones

### Auto-Sync

When enabled (`/sync`), RemoteCode watches the active session's `.jsonl` file and forwards new messages from Claude Code in real-time. This means if you use Claude Code on your host machine, you'll see the conversation in Telegram too.

The watcher polls for session changes every 3 seconds and uses `fs.watch` for file-level changes with 500ms debouncing.

## Configuration

### Config File

`~/.remotecode/config` -- simple key=value format:

```ini
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
REMOTECODE_ALLOWED_USERS=12345678,@username
REMOTECODE_YOLO=true
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `REMOTECODE_ALLOWED_USERS` | Yes | Comma/space-separated user IDs or @usernames |
| `REMOTECODE_YOLO` | No | `true` for full remote control (skips Claude Code permission prompts). Set `false` for read-only / monitoring use |
| `REMOTECODE_VERBOSE` | No | `true` to enable DEBUG-level logging |

## File Structure

```
~/.remotecode/
  config              # Global configuration (KV file)
  local               # Active session state (session ID, CWD, chat ID)
  remotecode.pid      # Daemon process ID
  remotecode.log      # Log file (5MB rotation, keeps .old)
  remotecode.log.old  # Previous rotated log
  whisper/
    ggml-small.bin    # Whisper model (if STT enabled)
  RemoteCodeSessions/ # Default CWD for new sessions
```

## Message Flow

```mermaid
flowchart TD
    A[Telegram Update] --> B{Message type?}
    B -->|callback_query| C[callbacks.ts]
    B -->|message| D{Content type?}

    D -->|text starts with /| E[commands.ts]
    D -->|text| F[handlePrompt]
    D -->|photo / image doc| G[Download & save image]
    D -->|voice / audio| H{STT ready?}

    H -->|No| I[Send setup instructions]
    H -->|Yes| J[Download → ffmpeg → whisper-cli]
    J --> K{Blank audio?}
    K -->|Yes| L[No speech detected]
    K -->|No| F

    G --> F

    F --> M[withSessionLock]
    M --> N[askClaude via CLI]
    N --> O{Session exists?}
    O -->|Yes| P[--resume session]
    O -->|No| Q[--session-id new]
    O -->|Busy| R[Retry up to 5x]

    P --> S[Format response]
    Q --> S
    R --> S
    S --> T[sendMessage HTML]

    C --> U{Action}
    U -->|sess:list| V[Show session grid]
    U -->|sess:ID| W[Switch session]
    U -->|sess:new| X[Create new session]
    U -->|proj:list| Y[Show project list]
    U -->|proj:DIR| Z[Show project sessions]
    U -->|sessdel:ID| AA[Delete session]
```

## Speech-to-Text (STT)

RemoteCode uses [whisper.cpp](https://github.com/ggerganov/whisper.cpp) for local, offline speech-to-text.

### Setup

```bash
remotecode setup-stt
```

This auto-detects your package manager and installs:
- **whisper-cpp** -- C++ inference engine for Whisper
- **ffmpeg** -- audio format conversion
- **ggml-small.bin** -- Whisper small model (~466 MB, downloaded from HuggingFace)

Supported package managers: Homebrew (macOS/Linux), apt (Ubuntu/Debian), dnf (Fedora/RHEL), yum (CentOS), pacman (Arch), apk (Alpine).

### How it works

1. Audio downloaded from Telegram (`.oga` format)
2. Converted to 16kHz mono WAV via `ffmpeg`
3. Transcribed via `whisper-cli -m ggml-small.bin -l auto`
4. Blank audio detection filters out silence/noise
5. Transcription sent to Claude Code as a regular prompt

## Security

- **User allowlist** -- Only configured user IDs and usernames can interact
- **Repeat block** -- Unauthorized users are warned once, then silently blocked
- **No webhook** -- Uses long polling, no public endpoints needed
- **Local STT** -- Voice transcription runs entirely offline via whisper.cpp
- **YOLO mode** -- Required for full remote control. Without it, any Claude Code action needing approval will hang since there's no terminal to confirm. If security is a concern, set YOLO to `false` and use RemoteCode for text conversations and monitoring only

## Development

```bash
# Run in development mode
npm run dev

# Build TypeScript
npm run build

# Run tests
npm test

# Watch tests
npm run test:watch
```

## License

[MIT](LICENSE)
