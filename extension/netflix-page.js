// Работает в контексте страницы Netflix. Управляет плеером через внутренний API Netflix:
// менять video.currentTime напрямую нельзя — Netflix сразу падает с ошибкой M7375.
(() => {
  function player() {
    try {
      const api = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = api.getAllPlayerSessionIds();
      const id = ids.find((session) => session.startsWith('watch')) ?? ids[0];
      return id ? api.getVideoPlayerBySessionId(id) : null;
    } catch {
      return null;
    }
  }

  function state() {
    const current = player();
    if (!current) return { type: 'netflix-state', ready: false };
    return {
      type: 'netflix-state',
      ready: true,
      time: current.getCurrentTime() / 1000,
      duration: current.getDuration() / 1000,
      paused: current.isPaused(),
      url: location.href,
    };
  }

  const post = (message) => window.postMessage({ kinoroom: 'from-page', ...message }, location.origin);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.kinoroom !== 'to-page' || event.data.type !== 'command') return;
    const current = player();
    if (current) {
      const { cmd, value } = event.data;
      if (cmd === 'play') current.play();
      else if (cmd === 'pause') current.pause();
      else if (cmd === 'seek' && Number.isFinite(value)) current.seek(Math.round(value * 1000));
    }
    post(state());
  });

  // Состояние дважды в секунду: KinoRoom по нему видит отставание и нажатия паузы прямо в Netflix
  setInterval(() => post(state()), 500);
})();
