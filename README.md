# MOSTAKIM AI

Smarter • Faster • For You

A mobile-first AI assistant with **streaming chat**, **real web search**, **file uploads with ZIP extraction** and a **media library**.
Everything runs from one Node.js app (Express). No build step.

```
MOSTAKIM-AI/
├─ package.json
├─ config.json        ← your API keys (server side only, git-ignored)
├─ config.js          ← loads config.json / environment variables
├─ index.js           ← backend (Express, API, uploads, ZIP, providers)
├─ .gitignore
├─ README.md
├─ src/
│  ├─ index.html      ← complete UI (home, chat, search, library, camera, mic)
│  ├─ style.css       ← design + dark mode + responsive layout
│  └─ setting.js      ← frontend-safe settings (no secrets!)
└─ image/
   └─ mostakim.ai.png ← logo / favicon
```

## 1. Run it

Requires **Node.js 20.12 or newer**.

```bash
npm install
npm start
```

Open http://localhost:3000

Pages: `/` (home) · `/?chat` · `/?search`

## 2. Add your API keys

Edit `config.json`. A key you leave empty simply disables that service; the rest keep working.

```json
{
  "geminiApiKey": "",
  "openaiApiKey": "",
  "groqApiKey": "",
  "openRouterApiKey": "",
  "searchApiKey": "",
  "searchProvider": "auto",
  "apiAuthKey": "",
  "corsOrigins": [],
  "port": 3000
}
```

| Setting | What it does |
|---|---|
| `geminiApiKey`, `groqApiKey`, `openaiApiKey`, `openRouterApiKey` | Chat providers. Every configured provider is used; if one fails **before** answering, the next one is tried automatically (order: Gemini → Groq → OpenAI → OpenRouter, change with `chatProviders`). |
| `searchApiKey` | Key for [Tavily](https://tavily.com) web search. Real results + an answer written from those results. |
| `searchProvider` | `auto` (default), `tavily`, `gemini` or `openai`. With `auto`: Tavily if `searchApiKey` is set, otherwise Gemini grounded search (uses the Gemini key), otherwise OpenAI search. |
| `apiAuthKey` | Optional. If set, external callers must send it (see *Public API*). The website itself keeps working. |
| `corsOrigins` | Optional. Origins allowed to call the API from a browser, e.g. `["https://myapp.com"]`. `["*"]` allows any. Empty = same-origin only. |

Optional extras you can add to `config.json`: `models` (`gemini`, `openai`, `groq`, `openRouter`, `openaiSearch`), `systemPrompt`, `limits` (`maxFileSizeMB`, `maxFilesPerUpload`, `userQuotaMB`, `zipMaxEntries`, `zipMaxTotalMB`, `fileRetentionDays`), `rateLimit` (`windowMs`, `api`, `ai`, `upload`), `trustProxy`.

Environment variables work as a fallback: `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `SEARCH_API_KEY`, `API_AUTH_KEY`, `CORS_ORIGINS`, `PORT` (a `.env` file is read too).

> Model names change over time. If a provider returns "model not found", set a current model name under `models` in `config.json`.

**Keys never reach the browser.** `config.json` and `config.js` are not inside the public `src/` folder, and the server refuses to serve them. Do not put secrets in `src/setting.js`.

## 3. Features

* **Home** – hero, Chat and Search cards, dark/light switch, menu drawer, scrolling ticker (`<marquee>`).
* **Chat** (`/?chat`) – real streaming (Server-Sent Events), Markdown + code blocks with copy, stop / regenerate / copy, error cards with *Try again*, conversation history saved in the browser (`localStorage`).
* **Search** (`/?search`) – answer and sources shown separately, clickable `[1] [2]` citation badges, recent searches.
* **+ menu** – Camera, Image, File, ZIP, Video, Audio, Document, Media Library. Uploads show real progress.
* **Camera** – uses the browser camera when allowed (HTTPS or localhost); otherwise falls back to the normal file/camera picker.
* **Microphone** – browser speech recognition where supported (Chrome/Edge/Safari). Unsupported browsers get a clear message.
* **Media Library** – preview, download, rename, delete, attach to chat; ZIP contents listed under their archive.
* **Dark mode** – saved in `localStorage`.

### What the AI can actually read
* Images → sent to vision-capable models.
* Text/code, Markdown, CSV, JSON, **DOCX**, **PPTX** → text is extracted and sent.
* PDF, audio, video → sent to Gemini only (inline, up to 15 MB each).
* ZIP → file list plus the text files inside.
* Anything the current model cannot read is **not faked**: the chat shows a notice such as *"photo.png can't be analyzed by the current AI model."*

### Upload safety
* Allowed: PNG, JPG, JPEG, WEBP, GIF, MP4, WEBM, MOV, MP3, WAV, M4A, OGG, PDF, TXT, MD, CSV, JSON, DOC, DOCX, XLS, XLSX, PPT, PPTX, ZIP.
* The **file content** is checked against its extension (a renamed `.html` as `.png` is rejected).
* Files are stored under random ids; names are sanitized; files are served with safe headers (`nosniff`, sandbox CSP) and never executed.
* ZIP: path-traversal / absolute-path archives are rejected, symlinks, encrypted entries and executables are skipped, limits on entry count and extracted size (zip-bomb protection), nested content is validated.
* Each browser / API client has its **own private library** (cookie or `x-client-id` header). Storage quota and automatic cleanup (`fileRetentionDays`, default 30) apply.

## 4. Public API

Base URL = your domain. JSON in, JSON or SSE out. Errors look like `{ "error": { "code": "…", "message": "…" } }`.

If `apiAuthKey` is set, add `-H "x-api-key: YOUR_KEY"` (or `Authorization: Bearer YOUR_KEY`) to every call.

```bash
# Status (no secrets, booleans only)
curl https://your-domain.com/api/status

# Chat – single JSON answer
curl -X POST https://your-domain.com/api/chat \
  -H "Content-Type: application/json" \
  -d '{"stream":false,"messages":[{"role":"user","content":"Hello!"}]}'
# -> {"reply":"…"}

# Chat – streaming (default). Events: delta | notice | error | done
curl -N -X POST https://your-domain.com/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Write a haiku"}]}'

# Search
curl -X POST https://your-domain.com/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"latest Node.js release","stream":false}'
# -> {"reply":"…","sources":[{"title":"…","url":"…","domain":"…"}]}

# Upload (multipart, field name "files"); keep the same x-client-id to reach your files later
curl -X POST https://your-domain.com/api/upload \
  -H "x-client-id: my-app-client-0001" \
  -F "files=@photo.png"

# Use an uploaded file in chat
curl -X POST https://your-domain.com/api/chat -H "Content-Type: application/json" -H "x-client-id: my-app-client-0001" \
  -d '{"stream":false,"messages":[{"role":"user","content":"Describe this","attachments":["FILE_ID"]}]}'

# Library
curl https://your-domain.com/api/files                         -H "x-client-id: my-app-client-0001"
curl -X PATCH  https://your-domain.com/api/files/FILE_ID -H "Content-Type: application/json" -d '{"name":"New name"}' -H "x-client-id: my-app-client-0001"
curl -X DELETE https://your-domain.com/api/files/FILE_ID       -H "x-client-id: my-app-client-0001"
# GET /api/files/FILE_ID/raw (preview) and /api/files/FILE_ID/download
```

Rate limits (per IP, per minute, configurable): 180 general, 20 chat/search, 30 uploads.

## 5. Deploying

This app **stores uploaded files on disk and streams responses**, so it needs a normal Node.js host (Render, Railway, Fly.io, a VPS, Replit …). It is **not** a fit for serverless platforms such as Vercel functions.

* Run `npm install && npm start`; set the port with `PORT` if the host requires it.
* Behind a proxy (Render, Railway, Nginx …) keep `trustProxy` at `1` so rate limiting sees real client IPs. If the app is directly on the internet, set `"trustProxy": false`.
* Serve over HTTPS (needed for the live camera in browsers).
* Disk storage on free tiers is often temporary — uploaded files may disappear on restart. Use a persistent disk if you need them to last.
* Set `NODE_ENV=production`.

## 6. Notes & limits

* Voice input depends on the browser's speech service (it needs an internet connection in Chrome).
* Chat history lives in the user's browser; clearing site data removes it. The media library lives on the server.
* There are no user accounts: privacy between visitors comes from an unguessable per-browser id. Anyone who has your `x-client-id` / cookie can see your library.
* `apiAuthKey` blocks outside callers, but the "same-origin" exception for the website relies on browser headers; treat it as protection against casual abuse, not as a substitute for a real login system.
