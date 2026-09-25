// Посредник на страницах KinoRoom: страница ↔ фон расширения ↔ вкладка Netflix.

let port = null;

function connect() {
  port = chrome.runtime.connect({ name: 'kinoroom' });
  port.onMessage.addListener((message) => window.postMessage({ kinoroomExt: 'to-page', ...message }, location.origin));
  port.onDisconnect.addListener(() => setTimeout(connect, 1000));
}
connect();

const announce = () => window.postMessage({ kinoroomExt: 'to-page', type: 'extension', version: chrome.runtime.getManifest().version }, location.origin);

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.kinoroomExt !== 'from-page') return;
  const { kinoroomExt, ...message } = event.data;
  // Страница спрашивает, установлено ли расширение (скрипт мог загрузиться раньше неё)
  if (message.type === 'hello') return announce();
  try {
    port.postMessage(message);
  } catch {}
});
announce();
