# MOSTAKIM AI

Smarter • Faster • For You

A mobile-first AI assistant: **streaming chat**, **real web search**, **file uploads with ZIP extraction** and a **media library**.
One Node.js app (Express), no build step.

```
MOSTAKIM-AI/
├─ package.json
├─ vercel.json        ← Vercel settings
├─ api/index.js       ← Vercel entry point (loads index.js)
├─ config.json        ← YOUR API KEYS go here (server side only)
├─ config.js          ← loads config.json / environment variables
├─ index.js           ← backend (API, uploads, ZIP, AI providers)
├─ .gitignore
├─ README.md
├─ src/
│  ├─ index.html      ← complete UI (home, chat, search, library, camera, mic)
│  ├─ style.css       ← design, dark mode, responsive layout
│  └─ setting.js      ← frontend-safe settings (never put keys here!)
└─ image/
   └─ mostakim.ai.png ← logo / favicon
```

---

## 1. Quick start (3 steps)

1. Get a free key from **Groq** and/or **Google AI Studio** (guide in section 2).
2. Paste the key(s) into `config.json` (section 3).
3. Run:

```bash
npm install
npm start
```

Open **http://localhost:3000** (Node.js 20.12 or newer is required).
The terminal prints `Chat: ready | Search: ready` when your keys were found.

Pages: `/` home · `/?chat` · `/?search`

---

## 2. How to get your API keys

You can use one key or both. **Both is best**: Gemini is the main model (it also reads images, PDF, audio, video and does web search) and Groq is a very fast backup that takes over automatically if Gemini is busy or fails.

> 🔒 A key is like a password. Never post it in a chat, screenshot or public repository. If a key leaks, delete it in the same console and create a new one.

### A) Groq key  →  https://console.groq.com/

1. Open **https://console.groq.com/** and **sign up / log in** (Google, GitHub or e-mail).
2. In the left menu open **API Keys** (direct link: https://console.groq.com/keys).
3. Click **Create API Key**, give it a name (for example `mostakim-ai`) and confirm.
4. **Copy the key now** - Groq shows it only once. It starts with `gsk_`.
5. Paste it into `config.json` as `groqApiKey` (section 3).

Notes
* Groq has a free plan with rate limits. Your current limits are shown in the Groq console (Settings → Limits).
* Groq models in this project are text-only: images/PDF/audio are handled by Gemini.

### B) Google AI Studio (Gemini) key  →  https://aistudio.google.com/app/apikey

1. Open **https://aistudio.google.com/app/apikey** and sign in with your **Google account**.
2. Click **Create API key**.
3. Choose an existing Google Cloud project, or pick **Create API key in new project** (AI Studio creates one for you).
4. **Copy the key.** It starts with `AIza`. (Google lets you open the same page later and copy it again.)
5. Paste it into `config.json` as `geminiApiKey` (section 3).

Notes
* The Gemini API has a **free tier** (no credit card). Daily/per-minute limits are shown in AI Studio and can change.
* On the free tier, Google may use your prompts to improve its products - don't send private or confidential data. A paid (billing-enabled) project is excluded from this.
* The same key powers **web search** (Gemini "Grounding with Google Search"), so Search works with only this key.

### C) Optional extras
| Key | Where | What it adds |
|---|---|---|
| `searchApiKey` | https://tavily.com | Alternative search backend (Tavily results + answer). Used first if set. |
| `openaiApiKey` | https://platform.openai.com/api-keys | Extra chat provider (paid). |
| `openRouterApiKey` | https://openrouter.ai/keys | Extra chat provider. |

---

## 3. Put the keys into `config.json`

Open `config.json`, paste each key **between the quotes**, save:

```json
{
  "geminiApiKey": "AIza...your-google-key...",
  "groqApiKey": "gsk_...your-groq-key...",
  "openaiApiKey": "",
  "openRouterApiKey": "",
  "searchApiKey": "",
  "searchProvider": "auto",
  "apiAuthKey": "",
  "corsOrigins": [],
  "port": 3000,
  "models": {
    "gemini": ["gemini-3.5-flash", "gemini-flash-latest"],
    "groq": ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]
  }
}
```

* Keep the quotes and commas exactly - one missing comma makes the whole file unreadable (then the app says *"AI service is not configured yet"*). You can check the file at https://jsonlint.com (paste it **without** your real keys).
* **Restart the server** after every change (`Ctrl + C`, then `npm start`).
* A key you leave empty simply turns that service off; everything else keeps working.

**Check that it works**
* Terminal shows `Chat: ready | Search: ready`.
* Open `http://localhost:3000/api/status` → `{"ok":true,"chat":true,"search":true,...}` (it shows only yes/no, never your keys).
* Open `/?chat`, say hello. Open `/?search`, search something.

### What each key gives you

| Feature | Gemini key | Groq key |
|---|---|---|
| Chat (streaming) | ✅ main | ✅ automatic backup |
| Read images | ✅ | ❌ (text only) |
| Read PDF / audio / video | ✅ | ❌ |
| Read text, code, DOCX, PPTX, ZIP file lists | ✅ | ✅ |
| Web search with sources | ✅ (Google Search grounding) | ❌ |

Order of use: Gemini → Groq → OpenAI → OpenRouter (change with `"chatProviders": [...]`). If a provider fails *before* answering, the next one is tried automatically.

### About model names (they get retired!)
AI companies retire models regularly. These defaults were checked in October 2026:
* Google: `gemini-2.5-flash` is scheduled for shutdown on **16 Oct 2026**, so the default is `gemini-3.5-flash` with `gemini-flash-latest` as backup.
* Groq: `llama-3.3-70b-versatile` was shut down on **16 Aug 2026**, so the default is `openai/gpt-oss-120b` with `openai/gpt-oss-20b` as backup.

Each setting is a **list**: if a model is "not found / retired", the app moves to the next one by itself. To pick a different model just edit the list (see https://ai.google.dev/gemini-api/docs/models and https://console.groq.com/docs/models).

---

## 4. Features

* **Home** - hero, Chat and Search cards, dark/light switch, menu drawer, scrolling ticker.
* **Chat** - real streaming, Markdown + code blocks with copy, stop / regenerate / copy, error cards with *Try again*, history saved in the browser.
* **Search** - answer and sources shown separately, clickable `[1] [2]` citations, recent searches.
* **+ menu** - Camera, Image, File, ZIP, Video, Audio, Document, Media Library (real upload progress).
* **Camera** (HTTPS/localhost) with fallback to the normal picker · **Microphone** via browser speech recognition.
* **Media Library** - preview, download, rename, delete, attach to chat; ZIP contents listed under the archive.

**What the AI can really read:** images (Gemini) · text/code/Markdown/CSV/JSON/DOCX/PPTX (text is extracted) · PDF, audio, video (Gemini, up to 15 MB each) · ZIP (file list + text files inside). Anything the current model cannot read is **not faked** - the chat shows a notice.

**Upload safety:** file *content* is checked against its extension · random file ids · sanitized names · safe response headers · ZIP path-traversal / absolute paths rejected, symlinks / encrypted / executables skipped, zip-bomb limits · every browser gets its own private library · storage quota + automatic cleanup (30 days).

---

## 5. Public API

Base URL = your domain. Errors: `{ "error": { "code": "…", "message": "…" } }`.
If `apiAuthKey` is set, add `-H "x-api-key: YOUR_KEY"` (or `Authorization: Bearer YOUR_KEY`).

```bash
curl https://your-domain.com/api/status

# Chat (single JSON answer)
curl -X POST https://your-domain.com/api/chat -H "Content-Type: application/json" \
  -d '{"stream":false,"messages":[{"role":"user","content":"Hello!"}]}'

# Chat streaming (events: delta | notice | error | done)
curl -N -X POST https://your-domain.com/api/chat -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Write a haiku"}]}'

# Search
curl -X POST https://your-domain.com/api/search -H "Content-Type: application/json" \
  -d '{"query":"latest Node.js release","stream":false}'

# Upload (field "files"); reuse x-client-id to reach your files later
curl -X POST https://your-domain.com/api/upload -H "x-client-id: my-app-client-0001" -F "files=@photo.png"

# Library
curl https://your-domain.com/api/files -H "x-client-id: my-app-client-0001"
curl -X PATCH  https://your-domain.com/api/files/FILE_ID -H "Content-Type: application/json" -d '{"name":"New name"}' -H "x-client-id: my-app-client-0001"
curl -X DELETE https://your-domain.com/api/files/FILE_ID -H "x-client-id: my-app-client-0001"
```

Rate limits per IP/minute (configurable): 180 general · 20 chat/search · 30 uploads.

---

## 6. Deploying

### Vercel (private GitHub repo)

Your repo is **private**, so committing `config.json` with your keys is fine - the app reads it on Vercel too.

1. Put the keys in `config.json`, commit, push to your **private** repo.
2. Vercel → **Add New → Project** → import the repo. Framework **Other**, leave build/output empty → **Deploy**.
3. Open `https://your-project.vercel.app`.

> ⚠️ If you ever make the repo **public** (or share the zip), your keys are exposed - delete and recreate them first.
>
> Prefer not to commit keys? Add `config.json` to `.gitignore` and set Environment Variables in Vercel instead: `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `SEARCH_API_KEY` (redeploy after changing).

**Vercel limits:** uploads max ~4 MB (Vercel's 4.5 MB body limit; the app lowers its limit automatically) · files are **temporary** (only `/tmp`, cleared when the function restarts - the Library shows a notice) · rate limits are per instance · streaming works (60 s function limit).

### Normal Node host (Render, Railway, VPS, Replit…)
`npm install && npm start` (`PORT` if required, `NODE_ENV=production`). Keep `trustProxy` at `1` behind a proxy, `false` if directly on the internet. Use HTTPS (live camera needs it) and a persistent disk if uploads must survive restarts.

---

## 7. Troubleshooting

| You see | Meaning / fix |
|---|---|
| *AI service is not configured yet.* | No key found. Check `config.json` (quotes, commas), key pasted between the quotes, then **restart**. On Vercel: redeploy. |
| *AI service is not configured correctly.* | The provider rejected the key (wrong, deleted or restricted). Create a new key and replace it. |
| *The AI service is busy right now.* | Rate limit (429). Wait a minute, or add the second provider as backup. |
| *The AI service is temporarily unavailable.* | Provider/network/model problem. Look at the terminal line `[chat] provider "…" failed: <status>` for the exact reason. If it mentions a model, update the `models` list. |
| *Search is not configured yet.* | Search needs the Gemini key (or `searchApiKey` / OpenAI). |
| *Search is temporarily unavailable.* | Search quota used up or provider error - retry later. |
| *This file type is not supported* / *content does not match its type* | Only the listed types are allowed and the real content must match. |
| *File size exceeds the allowed limit.* | Default 25 MB (4 MB on Vercel). Change `limits.maxFileSizeMB` on your own server. |
| Camera / mic do nothing | Allow permission in the browser; the live camera needs HTTPS or localhost; voice input needs Chrome/Edge/Safari. |
| Files vanished | Vercel / free hosts use temporary disks. |

## 8. Notes
* Chat history lives in the user's browser; the library lives on the server.
* There are no user accounts: privacy between visitors relies on an unguessable per-browser id.
* `apiAuthKey` stops casual outside use; it is not a replacement for real login.
