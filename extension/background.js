// Мост между вкладкой KinoRoom и вкладкой Netflix: команды идут в Netflix, состояние плеера — обратно.
// Если Netflix открыт в нескольких вкладках, управляется та, что подключилась последней.

const rooms = new Set();
let netflix = null;

function broadcast(message) {
  for (const room of rooms) room.postMessage(message);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'kinoroom') {
    rooms.add(port);
    port.onMessage.addListener((message) => netflix?.postMessage(message));
    port.onDisconnect.addListener(() => rooms.delete(port));
    port.postMessage({ type: 'netflix-status', connected: Boolean(netflix) });
    return;
  }
  if (port.name === 'netflix') {
    netflix = port;
    broadcast({ type: 'netflix-status', connected: true });
    port.onMessage.addListener(broadcast);
    port.onDisconnect.addListener(() => {
      if (netflix !== port) return;
      netflix = null;
      broadcast({ type: 'netflix-status', connected: false });
    });
  }
});
