#!/usr/bin/env bash
# Сторож малинки. Запускается таймером deploy/pi-watchdog.timer раз в 30 минут:
# проверяет службы и сайт, перезапускает то, что упало или зависло, и пишет владельцу в Telegram.
# Настройки — в /etc/default/pi-watchdog (пример в README, раздел «Сторож»).
set -u

SERVICES=${WATCHDOG_SERVICES:-kinoroom}
# «служба=адрес»: служба запущена, но адрес не отвечает — значит, зависла
HTTP_CHECKS=${WATCHDOG_HTTP_CHECKS:-kinoroom=http://localhost:3000/login}
# Порт, который должен быть открыт в интернет через Tailscale Funnel. Пусто — не следить
FUNNEL_PORT=${WATCHDOG_FUNNEL_PORT:-}
# .env Telegram-бота, от имени которого слать уведомления (TELEGRAM_BOT_TOKEN и TELEGRAM_OWNER_ID)
NOTIFY_ENV=${WATCHDOG_NOTIFY_ENV:-}

problems=()

env_value() {
  grep -m1 "^$1=" "$NOTIFY_ENV" 2>/dev/null | cut -d= -f2- | sed -E "s/^[\"']|[\"']\$//g"
}

notify() {
  [ -n "$NOTIFY_ENV" ] || return 0
  local token chat
  token=$(env_value TELEGRAM_BOT_TOKEN)
  chat=$(env_value TELEGRAM_OWNER_ID)
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  # Адрес с токеном идёт через stdin (-K -), чтобы не попасть в список процессов
  curl -s -m 15 -o /dev/null -K - --data-urlencode "chat_id=$chat" --data-urlencode "text=$1" \
    <<< "url = \"https://api.telegram.org/bot$token/sendMessage\"" || echo "не удалось отправить уведомление"
}

restart() {
  local unit=$1 reason=$2
  echo "↻ $unit: $reason — перезапускаю"
  systemctl reset-failed "$unit" 2>/dev/null
  systemctl restart "$unit"
  sleep 15
  if systemctl is-active --quiet "$unit"; then
    problems+=("♻️ $unit: $reason — перезапустил, работает")
  else
    problems+=("🚨 $unit: $reason — перезапуск не помог, смотри journalctl -u $unit")
  fi
}

responds() {
  curl -fs -m 15 -o /dev/null "$1"
}

online=true
if ! curl -s -m 10 -o /dev/null https://api.telegram.org; then
  online=false
  echo "⚠️ нет интернета — службы, которым он нужен, не трогаю: перезапуск им не поможет"
fi

# Упавшие службы. Сюда же попадают те, что systemd перестал поднимать после серии сбоев подряд
if $online; then
  for unit in $SERVICES; do
    systemctl is-enabled --quiet "$unit" 2>/dev/null || continue  # нет такой службы или выключена намеренно
    systemctl is-active --quiet "$unit" && continue
    restart "$unit" "не работала ($(systemctl show -p ActiveState --value "$unit"))"
  done
fi

# Зависшие сайты: процесс жив, но не отвечает. Вторая попытка — чтобы не дёргаться из-за одного медленного ответа
for check in $HTTP_CHECKS; do
  unit=${check%%=*}
  url=${check#*=}
  systemctl is-enabled --quiet "$unit" 2>/dev/null || continue
  if ! responds "$url" && ! { sleep 20; responds "$url"; }; then
    restart "$unit" "не отвечает на $url"
  fi
done

# Доступ из интернета. После обновлений Tailscale настройка Funnel иногда сбрасывается
if [ -n "$FUNNEL_PORT" ] && $online && tailscale status >/dev/null 2>&1; then
  if ! tailscale funnel status 2>/dev/null | grep -q "http://127.0.0.1:$FUNNEL_PORT"; then
    echo "↻ Tailscale Funnel выключен — включаю"
    if timeout 30 tailscale funnel --bg "$FUNNEL_PORT" >/dev/null 2>&1; then
      problems+=("♻️ доступ из интернета (Tailscale Funnel) был выключен — включил")
    else
      problems+=("🚨 не получается включить Tailscale Funnel — смотри tailscale funnel status")
    fi
  fi
fi

if [ ${#problems[@]} -eq 0 ]; then
  echo "✓ всё в порядке"
else
  printf '%s\n' "${problems[@]}"
  notify "🛠 Сторож малинки ($(hostname)):"$'\n'"$(printf '%s\n' "${problems[@]}")"
fi
