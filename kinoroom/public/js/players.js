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
              },
            });
          }),
      );
      this.ready.catch(() => (this.ready = null));
    }
    return this.ready;
  }

  handleState(state) {
    this.state = state;
    if (state === YT_STATE.PLAYING) this.events.onPlaying?.(this);
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
    this.src = media.url;
    this.pendingStart = start;
    const video = this.video;

    const isHls = /\.m3u8(\?|#|$)/i.test(new URL(media.url, location.href).pathname);
    if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      const Hls = await loadHls();
      if (token !== this.token) return;
      if (!Hls.isSupported()) throw new Error('Этот браузер не умеет играть HLS-потоки');
      this.hls = new Hls({ startPosition: start });
      this.hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) this.events.onError?.(this, 'HLS-поток недоступен');
      });
      this.hls.loadSource(media.url);
      this.hls.attachMedia(video);
    } else {
      video.src = media.url;
    }
    if (autoplay) this.play();
  }

  reset() {
    this.token += 1;
    this.src = null;
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
