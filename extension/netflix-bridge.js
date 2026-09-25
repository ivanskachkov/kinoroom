// Посредник на netflix.com. Плеером управляет netflix-page.js — он работает в контексте самой
// страницы, где доступен внутренний API Netflix, — а связь с KinoRoom идёт через фон расширения.

let port = null;

function connect() {
  port = chrome.runtime.connect({ name: 'netflix' });
  port.onMessage.addListener((message) => window.postMessage({ kinoroom: 'to-page', ...message }, location.origin));
  // Фон расширения может перезапуститься — переподключаемся
  port.onDisconnect.addListener(() => setTimeout(connect, 1000));
}
connect();

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.kinoroom !== 'from-page') return;
  const { kinoroom, ...message } = event.data;
  try {
    port.postMessage(message);
  } catch {}
});
