import { $, el, api, icon, formatTime, toast } from './common.js';

const enc = encodeURIComponent;

/** Распознаёт вставленную ссылку: YouTube, запись Internet Archive или прямой файл/поток. */
export function parseLink(text) {
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^(www|m|music)\./, '');

  let youtubeId = null;
  if (host === 'youtu.be') youtubeId = url.pathname.slice(1, 12);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    youtubeId = url.searchParams.get('v') ?? url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/)?.[1];
  }
  if (youtubeId && /^[\w-]{11}$/.test(youtubeId)) return { type: 'youtube', id: youtubeId };

  // Netflix: netflix.com/watch/ID или /title/ID (для фильма это один и тот же номер)
  if (host === 'netflix.com') {
    const netflixId = url.pathname.match(/\/(?:watch|title)\/(\d{5,12})/)?.[1];
    if (netflixId) return { type: 'netflix', id: netflixId };
  }

  // Google Диск: /file/d/ID/view, open?id=ID, uc?id=ID, drive.usercontent…/download?id=ID
  if (/^(drive|docs)\.google\.com$|^drive\.usercontent\.google\.com$/.test(host)) {
    if (url.pathname.includes('/folders/')) return { type: 'gdrive-folder' };
    const driveId = url.pathname.match(/\/file\/d\/([\w-]{10,})/)?.[1] ?? url.searchParams.get('id');
    if (driveId) return { type: 'gdrive', id: driveId };
  }

  const archiveId = host === 'archive.org' && url.pathname.match(/^\/(?:details|embed)\/([\w.-]+)/)?.[1];
  if (archiveId) return { type: 'archive', id: archiveId };

  const fileName = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
  return { type: 'file', url: url.href, title: fileName || url.hostname };
}

export function createSearch({ sources, onPlay, onQueue }) {
  const panel = $('#search-panel');
  const body = $('#search-body');
  const input = $('#search-input');
  let controller = null;
  let resultsView = null;

  $('#search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    run(input.value);
  });
  $('#search-close').addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) close();
  });

  function close() {
    panel.hidden = true;
    controller?.abort();
  }

  function run(raw) {
    const q = raw.trim();
    if (!q) return;
    controller?.abort();
    controller = new AbortController();
    panel.hidden = false;
    if (matchMedia('(hover: none)').matches) input.blur();

    const link = parseLink(q);
    $('#search-title').textContent = link ? 'Ссылка' : `Результаты: «${q}»`;
    resultsView = link ? linkView(link) : resultsFor(q);
    showView(resultsView);
  }

  function showView(node) {
    body.replaceChildren(node);
    body.scrollTop = 0;
  }

  const signal = () => controller?.signal;
  const backButton = () =>
    el('button', { class: 'btn btn-ghost btn-sm back', type: 'button', onclick: () => showView(resultsView) }, icon('back', 18), 'К результатам');

  // --- Секции результатов ---------------------------------------------------

  function section(title, load, render, { layout = 'cards', disabled, action = null, empty = 'Ничего не найдено' } = {}) {
    const count = el('span', { class: 'section-count' });
    const node = el('section', { class: 'search-section' }, el('h3', {}, title, count, action));
    if (!load) {
      node.append(el('p', { class: 'muted' }, disabled));
      return node;
    }
    const grid = el('div', { class: `grid grid-${layout}` }, skeletons(layout));
    node.append(grid);
    load()
      .then((data) => {
        const items = render(data);
        if (!items.length) return grid.replaceWith(el('p', { class: 'muted' }, empty));
        count.textContent = items.length;
        grid.replaceChildren(...items);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') grid.replaceWith(el('p', { class: 'error-text' }, err.message));
      });
    return node;
  }

  function skeletons(layout) {
    const n = layout === 'posters' ? 6 : 4;
    return Array.from({ length: n }, () => el('div', { class: `skeleton skeleton-${layout}` }));
  }

  const NO_FULL_VIDEO = 'Полной версии на YouTube не нашлось — или владелец запретил показывать её на других сайтах, или она недоступна в вашей стране.';

  // Раздел YouTube с переключателем «только полные фильмы» (видео длиннее 20 минут, без трейлеров и обзоров)
  function youtubeSection(q, long) {
    const toggle = el('button', { class: 'chip-btn', type: 'button' }, long ? 'Показать все видео' : 'Только полные фильмы');
    const node = section(
      long ? 'YouTube — полные фильмы' : 'YouTube',
      () => api(`/api/search/youtube?q=${enc(q)}${long ? '&long=1' : ''}`, { signal: signal() }),
      (r) => r.results.map(youtubeCard),
      { action: toggle, empty: long ? NO_FULL_VIDEO : 'Ничего не найдено' },
    );
    toggle.addEventListener('click', () => node.replaceWith(youtubeSection(q, !long)));
    return node;
  }

  function resultsFor(q) {
    const view = el('div', { class: 'search-view' });
    if (sources.gdriveFolder) view.append(driveSection(q));
    if (sources.tmdb) {
      view.append(section('Фильмы и сериалы', () => api(`/api/search/tmdb?q=${enc(q)}`, { signal: signal() }), (r) => r.results.map(tmdbCard), { layout: 'posters' }));
    }
    if (sources.library) {
      view.append(section('Медиатека', () => api(`/api/search/library?q=${enc(q)}`, { signal: signal() }), (r) => r.results.map(libraryCard)));
    }
    view.append(
      sources.youtube
        ? youtubeSection(q, false)
        : section('YouTube', null, null, {
            disabled: 'Поиск по YouTube выключен: нужен YOUTUBE_API_KEY в .env. Ссылку на видео можно вставить прямо в строку поиска.',
          }),
      section('Internet Archive', () => api(`/api/search/archive?q=${enc(q)}`, { signal: signal() }), (r) => r.results.map(archiveCard)),
    );
    view.append(
      sources.tmdb
        ? el('p', { class: 'hint' }, 'Данные о фильмах и постеры — ', el('a', { href: 'https://www.themoviedb.org', target: '_blank', rel: 'noopener' }, 'TMDB'), '. Этот продукт использует TMDB API, но не одобрен и не сертифицирован TMDB.')
        : el('p', { class: 'hint' }, 'Подсказка: добавьте TMDB_API_KEY в .env — появится поиск фильмов и сериалов с постерами, описаниями и трейлерами.'),
    );
    return view;
  }

  // --- Карточки -------------------------------------------------------------

  async function withBusy(button, task) {
    const card = button.closest('.card, .file-row');
    const buttons = card ? [...card.querySelectorAll('button')] : [button];
    buttons.forEach((b) => (b.disabled = true));
    try {
      await task();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  function mediaCard({ thumb, title, meta, badge, play, queue }) {
    const run = (action) => (event) => withBusy(event.currentTarget, action);
    return el(
      'article',
      { class: 'card' },
      el(
        'button',
        { class: 'card-thumb', type: 'button', onclick: run(play), 'aria-label': `Смотреть: ${title}` },
        thumb ? el('img', { src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('span', { class: 'thumb-fallback' }, icon('film', 32)),
        badge ? el('span', { class: 'badge' }, badge) : null,
        el('span', { class: 'card-play' }, icon('play', 26)),
      ),
      el(
        'div',
        { class: 'card-body' },
        el('h4', { class: 'card-title', title }, title),
        meta ? el('div', { class: 'card-meta' }, meta) : null,
        el(
          'div',
          { class: 'card-actions' },
          el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: run(play) }, icon('play', 16), 'Смотреть'),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: run(queue), 'aria-label': 'Добавить в очередь' }, icon('plus', 16), el('span', { class: 'hide-sm' }, 'В очередь')),
        ),
      ),
    );
  }

  function youtubeCard(video) {
    const media = { kind: 'youtube', id: video.id, title: video.title, thumb: video.thumb, source: 'youtube', duration: video.duration || null };
    return mediaCard({
      thumb: video.thumb,
      title: video.title,
      meta: video.channel,
      badge: video.live ? 'LIVE' : video.duration ? formatTime(video.duration) : null,
      play: () => onPlay(media),
      queue: () => onQueue(media),
    });
  }

  // Ваши фильмы на Google Диске: видео идёт каждому зрителю прямо с серверов Google
  function driveCard(file) {
    const media = { kind: 'file', url: file.url, title: file.title, source: 'gdrive', duration: file.duration };
    return mediaCard({
      title: file.title,
      meta: ['Google Диск', file.height ? `${file.height}p` : null].filter(Boolean).join(' · '),
      badge: file.duration ? formatTime(file.duration) : null,
      play: () => onPlay(media),
      queue: () => onQueue(media),
    });
  }

  function driveSection(q) {
    return section('Google Диск', () => api(`/api/search/gdrive${q ? `?q=${enc(q)}` : ''}`, { signal: signal() }), (r) => r.results.map(driveCard), {
      empty: q ? 'В папке на Диске такого нет' : 'Папка на Диске пуста — загрузите туда фильмы в .mp4',
    });
  }

  function libraryCard(file) {
    const media = { kind: 'file', url: file.url, title: file.title, source: 'library' };
    return mediaCard({ title: file.title, meta: file.folder || 'Медиатека', play: () => onPlay(media), queue: () => onQueue(media) });
  }

  async function resolveArchive(id) {
    const data = await api(`/api/archive/${enc(id)}`, { signal: signal() });
    if (!data.files.length) throw new Error('В этой записи нет видео, которое можно открыть в браузере');
    const multiple = data.files.length > 1;
    return {
      ...data,
      media: data.files.map((file) => ({
        kind: 'file',
        url: file.url,
        title: multiple ? `${data.title} — ${file.title}` : data.title,
        thumb: data.thumb,
        source: 'archive',
        duration: file.duration,
        variants: file.variants,
        fileTitle: file.title,
      })),
    };
  }

  function archiveCard(item) {
    const pick = (action) => async () => {
      const data = await resolveArchive(item.id);
      if (data.media.length === 1) action(data.media[0]);
      else showView(archiveFilesView(data));
    };
    return mediaCard({
      thumb: item.thumb,
      title: item.title,
      meta: [item.year, item.creator].filter(Boolean).join(' · ') || 'Internet Archive',
      play: pick(onPlay),
      queue: pick(onQueue),
    });
  }

  function archiveFilesView(data) {
    const rows = data.media.map((media) =>
      el(
        'div',
        { class: 'file-row' },
        el('div', { class: 'grow' }, el('div', { class: 'file-title' }, media.fileTitle), media.duration ? el('div', { class: 'card-meta' }, formatTime(media.duration)) : null),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Смотреть', title: 'Смотреть', onclick: () => onPlay(media) }, icon('play', 18)),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'В очередь', title: 'В очередь', onclick: () => onQueue(media) }, icon('plus', 18)),
      ),
    );
    return el(
      'div',
      { class: 'search-view' },
      backButton(),
      el(
        'div',
        { class: 'files-head' },
        el('img', { class: 'files-thumb', src: data.thumb, alt: '' }),
        el(
          'div',
          {},
          el('h2', {}, data.title),
          el('p', { class: 'muted' }, `${data.media.length} видео в записи`),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => onQueue(data.media) }, icon('queue', 16), 'Всё в очередь'),
        ),
      ),
      el('div', { class: 'file-list' }, rows),
    );
  }

  function tmdbCard(item) {
    const meta = [item.year, item.type === 'tv' ? 'сериал' : 'фильм', item.rating ? `★ ${item.rating.toFixed(1)}` : null].filter(Boolean).join(' · ');
    return el(
      'button',
      { class: 'poster', type: 'button', onclick: () => showView(tmdbView(item)) },
      item.poster ? el('img', { src: item.poster, alt: '', loading: 'lazy' }) : el('span', { class: 'poster-fallback' }, icon('film', 32)),
      el('span', { class: 'poster-title' }, item.title),
      el('span', { class: 'poster-meta' }, meta),
    );
  }

  // Где фильм есть легально в стране зрителей — по данным JustWatch через TMDB
  function whereToWatch(d) {
    const w = d.watch;
    if (!w) return null;
    const rows = [
      ['Подписка', w.subscription],
      ['Бесплатно', w.free],
      ['Аренда', w.rent],
      ['Покупка', w.buy],
    ].filter(([, names]) => names.length);
    if (!rows.length) return el('p', { class: 'muted where-watch' }, `Легально посмотреть в стране ${w.region}: данных нет`);
    return el(
      'div',
      { class: 'where-watch' },
      el('div', { class: 'where-title' }, `Где смотреть (${w.region})`),
      rows.map(([label, names]) => el('div', { class: 'where-row' }, el('span', { class: 'muted' }, `${label}: `), names.join(', '))),
    );
  }

  // Есть на Netflix — можно смотреть вместе: у каждого своя подписка, KinoRoom синхронизирует время.
  // Номера фильма в Netflix TMDB не знает, поэтому ссылка ведёт на поиск Netflix по названию.
  function netflixButton(d) {
    if (d.type !== 'movie' || !d.watch?.subscription.includes('Netflix')) return null;
    const button = el('button', { class: 'btn btn-primary', type: 'button' }, icon('play', 16), 'Смотреть вместе на Netflix');
    button.addEventListener('click', () =>
      onPlay({
        kind: 'external',
        service: 'netflix',
        url: `https://www.netflix.com/search?q=${encodeURIComponent(d.originalTitle || d.title)}`,
        title: d.title,
        thumb: d.poster,
        duration: d.runtime ? d.runtime * 60 : null,
        source: 'netflix',
      }),
    );
    return button;
  }

  function tmdbView(item) {
    const view = el('div', { class: 'search-view' }, backButton());
    const extra = el('div', { class: 'detail-extra' });
    const content = el('div', { class: 'detail' }, el('div', { class: 'skeleton skeleton-posters' }));
    view.append(content, extra);

    api(`/api/tmdb/${item.type}/${item.id}`, { signal: signal() })
      .then((d) => {
        const facts = [
          d.year,
          d.type === 'tv' ? (d.seasons ? `сериал · сезонов: ${d.seasons}` : 'сериал') : 'фильм',
          d.runtime ? `${d.runtime} мин` : null,
          d.rating ? `★ ${d.rating.toFixed(1)}` : null,
        ].filter(Boolean);
        const searchTitle = [d.title, d.year].filter(Boolean).join(' ');
        const archiveTitle = d.originalTitle || d.title;

        // Трейлеры уже есть в карточке, поэтому с YouTube ищем именно полную версию
        const isShow = d.type === 'tv';
        const youtubeButton = el('button', { class: 'btn btn-primary', type: 'button' }, icon('search', 16), isShow ? 'Найти серии на YouTube' : 'Найти полный фильм на YouTube');
        youtubeButton.addEventListener('click', () => {
          youtubeButton.disabled = true;
          const query = `${searchTitle} ${isShow ? 'сериал' : 'фильм'}`;
          extra.prepend(section(`YouTube — полные видео: «${searchTitle}»`, () => api(`/api/search/youtube?q=${enc(query)}&long=1`, { signal: signal() }), (r) => r.results.map(youtubeCard), { empty: NO_FULL_VIDEO }));
        });

        content.replaceChildren(
          d.poster ? el('img', { class: 'detail-poster', src: d.poster, alt: '' }) : el('div', { class: 'detail-poster poster-fallback' }, icon('film', 40)),
          el(
            'div',
            { class: 'detail-info' },
            el('h2', {}, d.title),
            d.originalTitle && d.originalTitle !== d.title ? el('div', { class: 'muted' }, d.originalTitle) : null,
            el('div', { class: 'detail-meta' }, facts.join(' · ')),
            d.genres.length ? el('div', { class: 'detail-genres' }, d.genres.map((g) => el('span', { class: 'chip' }, g))) : null,
            d.overview ? el('p', { class: 'detail-overview' }, d.overview) : null,
            whereToWatch(d),
            el('div', { class: 'detail-actions' }, netflixButton(d), sources.youtube ? youtubeButton : null),
          ),
        );

        // Archive и медиатека бесплатны — ищем сразу. YouTube тратит квоту, поэтому только по кнопке.
        if (d.videos.length) {
          extra.append(
            el(
              'section',
              { class: 'search-section' },
              el('h3', {}, 'Трейлеры'),
              el(
                'div',
                { class: 'grid grid-cards' },
                d.videos.map((v) =>
                  youtubeCard({ id: v.id, title: `${d.title} — ${v.name}`, channel: v.type, thumb: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` }),
                ),
              ),
            ),
          );
        }
        if (sources.library) {
          extra.append(section('В медиатеке', () => api(`/api/search/library?q=${enc(d.title)}`, { signal: signal() }), (r) => r.results.map(libraryCard)));
        }
        extra.append(section(`Internet Archive: «${archiveTitle}»`, () => api(`/api/search/archive?q=${enc(archiveTitle)}`, { signal: signal() }), (r) => r.results.map(archiveCard)));
      })
      .catch((err) => {
        if (err.name !== 'AbortError') content.replaceChildren(el('p', { class: 'error-text' }, err.message));
      });

    return view;
  }

  function linkView(link) {
    const view = el('div', { class: 'search-view' });
    if (link.type === 'netflix') {
      // Название по ссылке без входа в Netflix не узнать — его вписывает тот, кто включает
      const titleInput = el('input', { class: 'input', maxlength: '200', placeholder: 'Название фильма (для чата)', value: '' });
      const start = el('button', { class: 'btn btn-primary', type: 'button' }, icon('play', 16), 'Смотреть вместе на Netflix');
      start.addEventListener('click', () =>
        onPlay({ kind: 'external', service: 'netflix', ref: link.id, title: titleInput.value.trim() || 'Фильм на Netflix', source: 'netflix' }),
      );
      view.append(
        el('div', { class: 'netflix-card' }, el('span', { class: 'ext-service' }, 'NETFLIX'), titleInput, start),
        el('p', { class: 'hint' }, 'У каждого своя подписка Netflix. Видео каждый смотрит у себя, а KinoRoom даёт общий отсчёт, паузы и перемотку. На компьютере с расширением KinoRoom всё синхронизируется само.'),
      );
      return view;
    }
    if (link.type === 'gdrive-folder') {
      view.append(el('p', { class: 'hint' }, 'Это ссылка на папку. Вставьте ссылку на сам видеофайл — или укажите ID этой папки в GDRIVE_FOLDER_ID на сервере, и все фильмы из неё появятся в поиске.'));
      return view;
    }
    if (link.type === 'gdrive') {
      if (!sources.gdrive) {
        view.append(el('p', { class: 'error-text' }, 'Google Диск не подключён: на сервере нужен ключ GDRIVE_API_KEY в .env'));
        return view;
      }
      view.append(el('div', { class: 'grid grid-cards' }, el('div', { class: 'skeleton skeleton-cards' })));
      api(`/api/gdrive/${enc(link.id)}`, { signal: signal() })
        .then((file) => view.replaceChildren(el('div', { class: 'grid grid-cards' }, driveCard(file))))
        .catch((err) => view.replaceChildren(el('p', { class: 'error-text' }, err.message)));
      return view;
    }
    if (link.type === 'youtube') {
      const fallback = { id: link.id, title: 'Видео YouTube', channel: 'YouTube', thumb: `https://i.ytimg.com/vi/${link.id}/mqdefault.jpg` };
      const grid = el('div', { class: 'grid grid-cards' }, youtubeCard(fallback));
      view.append(grid);
      api(`/api/youtube/info/${link.id}`, { signal: signal() })
        .then((info) => grid.replaceChildren(youtubeCard(info)))
        .catch(() => {});
    } else if (link.type === 'archive') {
      view.append(el('div', { class: 'grid grid-cards' }, el('div', { class: 'skeleton skeleton-cards' })));
      resolveArchive(link.id)
        .then((data) => {
          if (data.media.length > 1) return view.replaceChildren(...archiveFilesView(data).children);
          const media = data.media[0];
          view.replaceChildren(el('div', { class: 'grid grid-cards' }, mediaCard({ thumb: media.thumb, title: media.title, meta: 'Internet Archive', play: () => onPlay(media), queue: () => onQueue(media) })));
        })
        .catch((err) => view.replaceChildren(el('p', { class: 'error-text' }, err.message)));
    } else {
      const media = { kind: 'file', url: link.url, title: link.title, source: 'link' };
      view.append(
        el('div', { class: 'grid grid-cards' }, mediaCard({ title: link.title, meta: new URL(link.url).hostname, play: () => onPlay(media), queue: () => onQueue(media) })),
        el('p', { class: 'hint' }, 'Подойдёт прямая ссылка на видеофайл (.mp4, .webm) или поток .m3u8. Страницы других сайтов с их собственным плеером синхронизировать нельзя.'),
      );
    }
    return view;
  }

  /** Все фильмы из папки на Google Диске — без поискового запроса. */
  function browseDrive() {
    controller?.abort();
    controller = new AbortController();
    panel.hidden = false;
    $('#search-title').textContent = 'Фильмы на Google Диске';
    resultsView = el('div', { class: 'search-view' }, driveSection(''));
    showView(resultsView);
  }

  return { close, open: (q) => ((input.value = q), run(q)), browseDrive };
}
