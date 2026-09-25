/*
 * Два плеера с одинаковым интерфейсом: YouTube (IFrame API) и обычный <video>
 * (mp4/webm, HLS через hls.js). Комната управляет ими только через этот интерфейс:
 *   load(media, start, autoplay) · play() · pause() · seek(t) · time() · duration()
 *   isPlaying() · isBuffering() · setRate(r) · setVolume(v) · setMuted(m) · stop() · show(v)
 * События приходят в events.onPlaying / onEnded / onBlocked / onError / onDuration
 * с плеером первым аргументом, чтобы комната отбрасывала события неактивного плеера.
 */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Не удалось загрузить ${src}`));
    document.head.append(script);
  });
}

let youtubeApi = null;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  youtubeApi ??= new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    loadScript('https://www.youtube.com/iframe_api').catch(() => {
      youtubeApi = null;
      reject(new Error('Не удалось загрузить плеер YouTube. Проверьте интернет.'));
    });
  });
  return youtubeApi;
}

let hlsLib = null;
function loadHls() {
  hlsLib ??= loadScript('/vendor/hls.min.js')
    .then(() => window.Hls)
    .catch((err) => {
      hlsLib = null;
      throw err;
    });
  return hlsLib;
}

const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

const YT_QUALITY = { tiny: '144p', small: '240p', medium: '360p', large: '480p', hd720: '720p', hd1080: '1080p', hd1440: '1440p', hd2160: '4K', highres: '4K+' };

const YT_ERRORS = {
  2: 'Неверная ссылка на видео YouTube',
  5: 'Плеер YouTube не может воспроизвести это видео',
  100: 'Видео удалено или скрыто владельцем',
  101: 'Владелец запретил показывать это видео на других сайтах',
  150: 'Владелец запретил показывать это видео на других сайтах',
};

export class YouTubePlayer {
  kind = 'youtube';

  constructor(host, events) {
    this.host = host;
    this.events = events;
    this.player = null;
    this.ready = null;
    this.state = YT_STATE.UNSTARTED;
    this.videoId = null;
    this.cuedAt = 0;
    this.captions = false;
  }

  init() {
    if (!this.ready) {
      this.ready = loadYouTubeApi().then(
        (YT) =>
          new Promise((resolve) => {
            const mount = document.createElement('div');
            this.host.append(mount);
            this.player = new YT.Player(mount, {
              width: '100%',
              height: '100%',
              playerVars: { controls: 0, disablekb: 1, fs: 0, playsinline: 1, rel: 0, iv_load_policy: 3, origin: location.origin },
              events: {
                onReady: () => resolve(),
                onStateChange: (e) => this.handleState(e.data),
                onError: (e) => this.events.onError?.(this, YT_ERRORS[e.data] ?? 'Ошибка плеера YouTube'),
                onAutoplayBlocked: () => this.events.onBlocked?.(this),
                // Модуль субтитров YouTube подгружает сам — сразу приводим его к нашей настройке
                onApiChange: () => this.applyCaptions(),
              },
            });
          }),
      );
      this.ready.catch(() => (this.ready = null));
    }
    return this.ready;
  }

  /**
   * Субтитры. Кнопки CC у встроенного плеера нет (панель управления своя), а YouTube включает
   * их сам — по настройкам аккаунта или если язык видео не совпал с языком зрителя.
   * loadModule/unloadModule нет в документации, но это общепринятый способ управлять ими.
   */
  setCaptions(on) {
    this.captions = on;
    this.applyCaptions();
  }

  applyCaptions() {
    const player = this.player;
    if (!player?.loadModule) return;
    try {
      if (this.captions) player.loadModule('captions');
      else {
        player.unloadModule('captions');
        player.unloadModule('cc');
      }
    } catch {}
  }

  handleState(state) {
    this.state = state;
    if (state === YT_STATE.PLAYING) {
      this.applyCaptions(); // при смене видео YouTube снова включает субтитры по своим правилам
      this.events.onPlaying?.(this);
    }
    if (state === YT_STATE.ENDED) this.events.onEnded?.(this);
    this.events.onDuration?.(this);
  }

  async load(media, start, autoplay) {
    await this.init();
    this.videoId = media.id;
    this.cuedAt = start;
    this.state = YT_STATE.UNSTARTED;
    const options = { videoId: media.id, startSeconds: start };
    if (autoplay) this.player.loadVideoById(options);
    else this.player.cueVideoById(options);
  }

  // Видео загружено, но ещё ни разу не запускалось: getCurrentTime() тут возвращает 0.
  isIdle() {
    return this.state === YT_STATE.UNSTARTED || this.state === YT_STATE.CUED;
  }

  play() {
    this.player?.playVideo();
  }

  pause() {
    if (!this.isIdle()) this.player?.pauseVideo();
  }

  seek(t) {
    if (!this.player || !this.videoId) return;
    if (!this.isIdle()) {
      this.player.seekTo(t, true);
      return;
    }
    // seekTo на незапущенном видео запускает воспроизведение, поэтому просто переставляем старт.
    this.cuedAt = t;
    if (this.state === YT_STATE.CUED) this.player.cueVideoById({ videoId: this.videoId, startSeconds: t });
  }

  time() {
    if (!this.player || this.isIdle()) return this.cuedAt;
    return this.player.getCurrentTime?.() ?? 0;
  }

  duration() {
    return this.player?.getDuration?.() || 0;
  }

  isPlaying() {
    return this.state === YT_STATE.PLAYING || this.state === YT_STATE.BUFFERING;
  }

  isBuffering() {
    return this.state === YT_STATE.BUFFERING;
  }

  setRate() {
    // YouTube поддерживает только фиксированные скорости (0.75, 1.25…) — для плавной подстройки не годится.
  }

  /** Качество, которое YouTube выбрал сам: задать его во встроенном плеере нельзя с 2019 года. */
  qualityLabel() {
    return YT_QUALITY[this.player?.getPlaybackQuality?.()] ?? null;
  }

  setVolume(level) {
    this.player?.setVolume?.(Math.round(level * 100));
  }

  setMuted(muted) {
    if (!this.player?.mute) return;
    if (muted) this.player.mute();
    else this.player.unMute();
  }

  stop() {
    if (!this.videoId) return;
    this.videoId = null;
    this.player?.stopVideo?.();
  }

  show(visible) {
    this.host.hidden = !visible;
  }
}

/**
 * Фильм на Netflix. Видео у каждого своё — в его аккаунте, — а этот «плеер» только держит время.
 * С расширением KinoRoom (компьютер, вкладка netflix.com) команды уходят в настоящий плеер Netflix,
 * и KinoRoom видит его время. Без расширения это виртуальные часы: зрители жмут кнопки сами,
 * по отсчёту и подсказкам на экране.
 */
export class NetflixPlayer {
  kind = 'external';

  constructor(view, events) {
    this.view = view;
    this.events = events;
    this.media = null;
    this.extension = false; // расширение установлено
    this.connected = false; // открыта вкладка Netflix
    this.remote = null; // последнее состояние плеера Netflix
    this.remoteAt = 0;
    this.lastCommandAt = 0;
    this.clock = { playing: false, time: 0, at: 0 }; // виртуальные часы без расширения
    window.addEventListener('message', (event) => this.onMessage(event));
    this.send({ type: 'hello' });
  }

  /** Автоматическая синхронизация: расширение есть и в соседней вкладке открыт фильм. */
  get auto() {
    return Boolean(this.extension && this.connected && this.remote?.ready);
  }

  send(message) {
    window.postMessage({ kinoroomExt: 'from-page', ...message }, location.origin);
  }

  command(cmd, value) {
    this.lastCommandAt = performance.now();
    // Запоминаем, чего ждём от плеера: такие изменения — наши, а не действия зрителя
    if (cmd === 'play' || cmd === 'pause') this.expectPaused = cmd === 'pause';
    if (cmd === 'seek') this.expectTime = value;
    this.send({ type: 'command', cmd, value });
  }

  onMessage(event) {
    if (event.source !== window || event.data?.kinoroomExt !== 'to-page') return;
    const message = event.data;
    const wasAuto = this.auto;
    if (message.type === 'extension') this.extension = true;
    else if (message.type === 'netflix-status') {
      this.connected = message.connected;
      if (!message.connected) this.remote = null;
    } else if (message.type === 'netflix-state') {
      this.extension = true;
      this.connected = true;
      this.detectUserAction(this.remote, message);
      this.remote = message;
      this.remoteAt = performance.now();
      this.events.onDuration?.(this);
    }
    if (wasAuto !== this.auto || message.type !== 'netflix-state') this.events.onExternalStatus?.(this);
  }

  // Пауза или перемотка прямо в Netflix (не нашей командой) — сообщаем комнате.
  // Сразу после нашей команды плеер меняется сам — такие изменения отличаем по тому, что мы заказали.
  detectUserAction(previous, next) {
    if (!this.media || !previous?.ready || !next.ready) return;
    const recent = performance.now() - this.lastCommandAt < 2000;
    if (previous.paused !== next.paused) {
      if (recent && next.paused === this.expectPaused) return;
      this.events.onUserControl?.(this, next.paused ? 'pause' : 'play', next.time);
      return;
    }
    const elapsed = (performance.now() - this.remoteAt) / 1000;
    const expected = previous.paused ? previous.time : previous.time + elapsed;
    if (Math.abs(next.time - expected) <= 4) return;
    if (recent && Number.isFinite(this.expectTime) && Math.abs(next.time - this.expectTime) < 2) return;
    this.events.onUserControl?.(this, 'seek', next.time);
  }

  async load(media, start) {
    this.media = media;
    this.clock = { playing: false, time: start, at: performance.now() };
  }

  clockTime() {
    const { playing, time, at } = this.clock;
    return playing ? time + (performance.now() - at) / 1000 : time;
  }

  play() {
    if (this.auto) this.command('play');
    else this.clock = { playing: true, time: this.clockTime(), at: performance.now() };
  }

  pause() {
    if (this.auto) this.command('pause');
    else this.clock = { playing: false, time: this.clockTime(), at: performance.now() };
  }

  seek(t) {
    if (this.auto) this.command('seek', t);
    else this.clock = { ...this.clock, time: t, at: performance.now() };
  }

  time() {
    if (!this.auto) return this.clockTime();
    const { time, paused } = this.remote;
    return paused ? time : time + (performance.now() - this.remoteAt) / 1000;
  }

  duration() {
    return (this.auto ? this.remote.duration : 0) || this.media?.duration || 0;
  }

  isPlaying() {
    return this.auto ? !this.remote.paused : this.clock.playing;
  }

  isBuffering() {
    return false;
  }

  setRate() {}

  setVolume() {}

  setMuted() {}

  stop() {
    this.media = null;
  }

  show(visible) {
    this.view.hidden = !visible;
  }
}

const MEDIA_ERRORS = {
  1: 'Загрузка видео прервана',
  2: 'Не удалось загрузить видео — проверьте ссылку или интернет',
  3: 'Видео повреждено или закодировано неподдерживаемым кодеком',
  4: 'Браузер не умеет играть этот формат, или ссылка недоступна',
};

export class FilePlayer {
  kind = 'file';

  constructor(video, events) {
    this.video = video;
    this.events = events;
    this.hls = null;
    this.src = null;
    this.media = null;
    this.quality = 'auto'; // 'auto' или «не выше N строк» — личная настройка этого устройства
    this.pendingStart = 0;
    this.token = 0;

    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('playing', () => events.onPlaying?.(this));
    video.addEventListener('ended', () => events.onEnded?.(this));
    video.addEventListener('durationchange', () => events.onDuration?.(this));
    video.addEventListener('loadedmetadata', () => {
      if (this.pendingStart > 0) video.currentTime = this.pendingStart;
      this.pendingStart = 0;
    });
    video.addEventListener('error', () => {
      if (this.src) events.onError?.(this, MEDIA_ERRORS[video.error?.code] ?? 'Ошибка воспроизведения');
    });
  }

  async load(media, start, autoplay) {
    this.reset();
    const token = this.token;
    const url = this.pickUrl(media);
    this.media = media;
    this.src = url;
    this.pendingStart = start;
    const video = this.video;

    const isHls = /\.m3u8(\?|#|$)/i.test(new URL(url, location.href).pathname);
    if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      const Hls = await loadHls();
      if (token !== this.token) return;
      if (!Hls.isSupported()) throw new Error('Этот браузер не умеет играть HLS-потоки');
      this.hls = new Hls({ startPosition: start });
      this.hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) this.events.onError?.(this, 'HLS-поток недоступен');
      });
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => this.applyHlsCap());
      this.hls.loadSource(url);
      this.hls.attachMedia(video);
    } else {
      video.src = url;
    }
    if (autoplay) this.play();
  }

  // --- Качество. Меняется только у этого зрителя: таймлайн у всех версий общий ---

  /** Версия под настройку «не выше N строк»; «Авто» — та, что сервер счёл лучшей. */
  pickUrl(media) {
    const variants = media.variants;
    if (!variants?.length || this.quality === 'auto') return media.url;
    const fitting = variants.filter((variant) => variant.height <= this.quality); // от большего к меньшему
    return (fitting[0] ?? variants.at(-1)).url;
  }

  setQuality(quality) {
    this.quality = quality;
    if (this.hls) return this.applyHlsCap();
    if (!this.media?.variants || !this.src) return;
    const url = this.pickUrl(this.media);
    if (url !== this.src) this.switchSource(url);
  }

  // Другая версия того же видео — с той же секунды и в том же состоянии
  switchSource(url) {
    const time = this.time();
    const wasPlaying = this.isPlaying();
    this.src = url;
    this.pendingStart = time;
    this.video.src = url;
    if (wasPlaying) this.play();
  }

  // У HLS-потока качество выбирает сам hls.js под скорость — ограничиваем ему потолок
  applyHlsCap() {
    const levels = this.hls?.levels ?? [];
    if (!levels.length) return;
    if (this.quality === 'auto') {
      this.hls.autoLevelCapping = -1;
      return;
    }
    const byHeight = levels.map((level, index) => ({ index, height: level.height ?? 0 })).sort((a, b) => b.height - a.height);
    this.hls.autoLevelCapping = (byHeight.find((level) => level.height <= this.quality) ?? byHeight.at(-1)).index;
  }

  /** Высоты, из которых можно выбрать (от большей к меньшей), или null — выбирать не из чего. */
  qualityOptions() {
    const heights = this.hls
      ? (this.hls.levels ?? []).map((level) => level.height).filter(Boolean)
      : (this.media?.variants ?? []).map((variant) => variant.height);
    const unique = [...new Set(heights)].sort((a, b) => b - a);
    return unique.length > 1 ? unique : null;
  }

  currentHeight() {
    if (this.hls) return this.hls.levels?.[this.hls.currentLevel]?.height ?? null;
    const variant = this.media?.variants?.find((item) => item.url === this.src);
    return variant?.height ?? (this.video.videoHeight || null);
  }

  reset() {
    this.token += 1;
    this.src = null;
    this.media = null;
    this.hls?.destroy();
    this.hls = null;
    this.video.removeAttribute('src');
    this.video.load();
    this.video.playbackRate = 1;
  }

  play() {
    this.video.play()?.catch((err) => {
      if (err?.name === 'NotAllowedError') this.events.onBlocked?.(this);
    });
  }

  pause() {
    this.video.pause();
  }

  seek(t) {
    if (this.video.readyState < 1) this.pendingStart = t;
    else this.video.currentTime = t;
  }

  time() {
    return this.video.readyState < 1 ? this.pendingStart : this.video.currentTime;
  }

  duration() {
    const d = this.video.duration;
    return Number.isFinite(d) ? d : 0;
  }

  isPlaying() {
    return !this.video.paused && !this.video.ended;
  }

  isBuffering() {
    return this.isPlaying() && this.video.readyState < 3;
  }

  setRate(rate) {
    if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
  }

  setVolume(level) {
    this.video.volume = level;
  }

  setMuted(muted) {
    this.video.muted = muted;
  }

  stop() {
    if (this.src) this.reset();
  }

  show(visible) {
    this.video.hidden = !visible;
  }
}
