// Cloudflare Turnstile site key (public). Leave empty only for local development.
window.SHIELD_CONFIG = {
  turnstileSiteKey: "0x4AAAAAAFZfCgc71OGY4l6U",
  apiPath: "/api/analyze",
  loginPath: "/api/login",
  // Minutes of inactivity before the user is signed out.
  sessionMinutes: 30,
  // Shown in the footer; bump on every release.
  appVersion: "1.1.0",
  releaseDate: "2026-11-04",
};
