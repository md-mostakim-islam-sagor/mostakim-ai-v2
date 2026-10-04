'use strict';

/**
 * Server-side configuration loader.
 *
 * Order of precedence (first non-empty value wins):
 *   1. config.json            (never sent to the browser, git-ignored)
 *   2. environment variables  (optional fallback, e.g. GEMINI_API_KEY)
 *   3. built-in defaults
 *
 * This module is only ever required by index.js on the server.
 * Nothing from here is exposed through static files or API responses.
 */

const fs = require('fs');
const path = require('path');

// Optional .env support without extra dependencies (Node >= 20.12).
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path.join(__dirname, '.env'));
  }
} catch (_) {
  /* no .env file - that's fine */
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[config] config.json could not be read. Please check its JSON syntax.');
    }
    return {};
  }
}

const file = readJsonFile(path.join(__dirname, 'config.json'));
const env = process.env;

const PLACEHOLDER = /^(your[_-]|put[_-]|paste[_-]|xxx|changeme)/i;

function str(...values) {
  for (const v of values) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t && !PLACEHOLDER.test(t)) return t;
    }
  }
  return '';
}

function num(fallback, ...values) {
  for (const v of values) {
    const n = Number(v);
    if (v !== '' && v !== null && v !== undefined && Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function list(fallback, ...values) {
  for (const v of values) {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'string' && v.trim()) return v.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return fallback;
}

function trustProxyValue() {
  const raw = file.trustProxy ?? env.TRUST_PROXY ?? 1;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false' || s === '0' || s === '') return false;
  const n = Number(s);
  return Number.isFinite(n) ? n : s; // allow "loopback" etc.
}

const models = file.models || {};
const limits = file.limits || {};
const rate = file.rateLimit || {};

const config = Object.freeze({
  port: num(3000, file.port, env.PORT),
  host: str(file.host, env.HOST) || '0.0.0.0',
  trustProxy: trustProxyValue(),
  isProduction: (env.NODE_ENV || '').toLowerCase() === 'production',

  // ---- credentials (server side only) ----
  geminiApiKey: str(file.geminiApiKey, env.GEMINI_API_KEY),
  openaiApiKey: str(file.openaiApiKey, env.OPENAI_API_KEY),
  groqApiKey: str(file.groqApiKey, env.GROQ_API_KEY),
  openRouterApiKey: str(file.openRouterApiKey, env.OPENROUTER_API_KEY),
  searchApiKey: str(file.searchApiKey, env.SEARCH_API_KEY),

  // "auto" | "tavily" | "gemini" | "openai"
  searchProvider: (str(file.searchProvider, env.SEARCH_PROVIDER) || 'auto').toLowerCase(),
  // order in which configured chat providers are tried (automatic fallback)
  chatProviders: list(['gemini', 'groq', 'openai', 'openRouter'], file.chatProviders, env.CHAT_PROVIDERS),

  models: Object.freeze({
    gemini: str(models.gemini, env.GEMINI_MODEL) || 'gemini-2.5-flash',
    openai: str(models.openai, env.OPENAI_MODEL) || 'gpt-4o-mini',
    groq: str(models.groq, env.GROQ_MODEL) || 'llama-3.3-70b-versatile',
    openRouter: str(models.openRouter, env.OPENROUTER_MODEL) || 'openrouter/auto',
    openaiSearch: str(models.openaiSearch, env.OPENAI_SEARCH_MODEL) || 'gpt-4o-mini-search-preview'
  }),

  systemPrompt:
    str(file.systemPrompt) ||
    "You are MOSTAKIM AI, a helpful, accurate and friendly assistant created by MOSTAKIM LAB'S. " +
      "Reply in the same language the user writes in. Use Markdown for formatting and fenced code blocks for code. " +
      'Be concise by default and go deeper when asked. If you are unsure, say so instead of guessing.',

  // ---- public API protection ----
  apiAuthKey: str(file.apiAuthKey, env.API_AUTH_KEY),
  corsOrigins: list([], file.corsOrigins, env.CORS_ORIGINS),

  limits: Object.freeze({
    maxFileSizeMB: num(25, limits.maxFileSizeMB, env.MAX_FILE_SIZE_MB),
    maxFilesPerUpload: Math.floor(num(10, limits.maxFilesPerUpload, env.MAX_FILES_PER_UPLOAD)),
    userQuotaMB: num(200, limits.userQuotaMB, env.USER_QUOTA_MB),
    zipMaxEntries: Math.floor(num(500, limits.zipMaxEntries)),
    zipMaxTotalMB: num(100, limits.zipMaxTotalMB),
    fileRetentionDays: num(30, limits.fileRetentionDays, env.FILE_RETENTION_DAYS)
  }),

  rateLimit: Object.freeze({
    windowMs: num(60000, rate.windowMs),
    api: Math.floor(num(180, rate.api)),
    ai: Math.floor(num(20, rate.ai)),
    upload: Math.floor(num(30, rate.upload))
  })
});

module.exports = config;
