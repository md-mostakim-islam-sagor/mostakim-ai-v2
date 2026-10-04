/*
 * MOSTAKIM AI - frontend-safe settings.
 * This file is public (the browser downloads it). NEVER put API keys or secrets here.
 * Provider keys live in config.json on the server.
 */
window.MOSTAKIM_SETTINGS = Object.freeze({
  appName: 'MOSTAKIM AI',
  tagline: 'Smarter • Faster • For You',
  greetingName: 'MOSTAKIM',
  logo: '/image/mostakim.ai.png',

  tickerText: 'Welcome to MOSTAKIM AI • Ask anything • Search the web • Explore more',
  footerText: "© 2026 MOSTAKIM AI • All Rights Reserved • MOSTAKIM LAB'S",
  poweredBy: "Powered by MOSTAKIM LAB'S",

  placeholder: 'Ask MOSTAKIM AI...',
  searchPlaceholder: 'Search the web...',

  // '' = use the browser language for voice input (e.g. 'en-US', 'bn-BD')
  speechLang: '',

  // conversation history kept in this browser
  maxHistoryMessages: 30,
  maxConversations: 50,

  // fallback values; the server's real limits are read from /api/status
  limits: { maxFileSizeMB: 25, maxFiles: 10 }
});
