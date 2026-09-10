#!/usr/bin/env bash
set -euo pipefail

compositor=${1:-}
decorations=${2:-}
case "$compositor" in
  mutter-wayland|sway-wayland|weston-wayland) backend=wayland ;;
  mutter-x11) backend=x11 ;;
  wayland) compositor=weston-wayland; backend=wayland ;;
  x11) compositor=mutter-x11; backend=x11 ;;
  *)
    echo "usage: $0 mutter-wayland|sway-wayland|weston-wayland|mutter-x11 client|server" >&2
    exit 64
    ;;
esac
if [[ "$decorations" != "client" && "$decorations" != "server" ]]; then
  echo "usage: $0 mutter-wayland|sway-wayland|weston-wayland|mutter-x11 client|server" >&2
  exit 64
fi

artifacts=${HEDDLEWORK_SMOKE_ARTIFACTS:-/tmp/heddlework-linux-smoke-results}
if [[ $(id -u) == 0 ]] && id heddlework-smoke >/dev/null 2>&1 && [[ ${HEDDLEWORK_SMOKE_UNPRIVILEGED:-0} != 1 ]]; then
  smoke_home=$(getent passwd heddlework-smoke | cut -d: -f6)
  [[ -n "$smoke_home" ]] || { echo "heddlework-smoke has no home directory" >&2; exit 1; }
  mkdir -p "$artifacts" "$smoke_home/.cache"
  chown heddlework-smoke:heddlework-smoke "$artifacts" "$smoke_home/.cache"
  exec runuser -u heddlework-smoke --preserve-environment -- env \
    HOME="$smoke_home" \
    XDG_CACHE_HOME="$smoke_home/.cache" \
    HEDDLEWORK_SMOKE_UNPRIVILEGED=1 \
    "$0" "$compositor" "$decorations"
fi

runtime=$(mktemp -d "/tmp/heddlework-${compositor}-${decorations}.XXXXXX")
mkdir -p "$artifacts"
chmod 700 "$runtime"
compositor_pid=
xvfb_pid=

cleanup() {
  set +e
  [[ -z "$compositor_pid" ]] || kill -- "-$compositor_pid" 2>/dev/null || kill "$compositor_pid" 2>/dev/null
  [[ -z "$xvfb_pid" ]] || kill -- "-$xvfb_pid" 2>/dev/null || kill "$xvfb_pid" 2>/dev/null
  wait "$compositor_pid" "$xvfb_pid" 2>/dev/null
  rm -rf "$runtime"
}
trap cleanup EXIT INT TERM

icd=$(find /usr/share/vulkan/icd.d -maxdepth 1 -name 'lvp_icd*.json' -print -quit)
if [[ -z "$icd" ]]; then
  echo "lavapipe ICD is missing" >&2
  exit 1
fi
export VK_DRIVER_FILES=$icd
export VK_ICD_FILENAMES=$icd
export LIBGL_ALWAYS_SOFTWARE=1
export WGPU_BACKEND=vulkan
export XDG_RUNTIME_DIR=$runtime
export HEDDLEWORK_SMOKE_GPUIX_REVISION
HEDDLEWORK_SMOKE_GPUIX_REVISION=$(jq -r '.gpuixRevision' gpuix-runtime.json)
vulkaninfo --summary > "$artifacts/vulkan-${compositor}-${decorations}.log" 2>&1

report="$artifacts/${compositor}-${decorations}.json"
compositor_log="$artifacts/${compositor}-${decorations}.log"
if [[ "$backend" == "wayland" ]]; then
  unset DISPLAY
  export XDG_SESSION_TYPE=wayland
  export WAYLAND_DEBUG=client
  case "$compositor" in
    mutter-wayland)
      setsid dbus-run-session -- mutter --wayland --headless --virtual-monitor 1280x800 --no-x11 > "$compositor_log" 2>&1 &
      compositor_pid=$!
      ;;
    sway-wayland)
      cat > "$runtime/sway.conf" <<'EOF'
output * mode 1280x800
seat seat0 fallback true
xwayland disable
default_border normal
EOF
      export WLR_BACKENDS=headless
      export WLR_HEADLESS_OUTPUTS=1
      export WLR_RENDERER=pixman
      export WLR_LIBINPUT_NO_DEVICES=1
      setsid sway --unsupported-gpu --config "$runtime/sway.conf" --debug > "$compositor_log" 2>&1 &
      compositor_pid=$!
      ;;
    weston-wayland)
      export WAYLAND_DISPLAY=wayland-heddlework
      setsid weston --backend=headless --renderer=pixman --socket="$WAYLAND_DISPLAY" --idle-time=0 --width=1280 --height=800 --no-config \
        --log="$compositor_log" &
      compositor_pid=$!
      ;;
  esac
  for _ in $(seq 1 240); do
    socket=$(find "$runtime" -maxdepth 1 -type s -name 'wayland-*' -print -quit)
    [[ -n "$socket" ]] && break
    kill -0 "$compositor_pid" 2>/dev/null || { cat "$compositor_log" >&2; exit 1; }
    sleep 0.05
  done
  [[ -n ${socket:-} ]] || { echo "$compositor Wayland socket did not appear" >&2; cat "$compositor_log" >&2; exit 1; }
  export WAYLAND_DISPLAY=${socket##*/}
  if [[ "$compositor" == sway-wayland ]]; then
    for _ in $(seq 1 100); do
      sway_socket=$(find "$runtime" -maxdepth 1 -type s -name 'sway-ipc*.sock' -print -quit)
      [[ -n "$sway_socket" ]] && break
      sleep 0.05
    done
    [[ -n ${sway_socket:-} ]] || { echo "Sway IPC socket did not appear" >&2; cat "$compositor_log" >&2; exit 1; }
    export SWAYSOCK=$sway_socket
    swaymsg -t get_outputs | jq -e 'any(.[]; .active and .rect.width == 1280 and .rect.height == 800)' > /dev/null
    wayland-scanner client-header packaging/linux/smoke-wlr-virtual-pointer.xml "$runtime/wlr-virtual-pointer-client-protocol.h"
    wayland-scanner private-code packaging/linux/smoke-wlr-virtual-pointer.xml "$runtime/wlr-virtual-pointer-protocol.c"
    cc -std=c11 -D_DEFAULT_SOURCE -I"$runtime" packaging/linux/smoke-wayland-drag.c "$runtime/wlr-virtual-pointer-protocol.c" \
      -o "$runtime/smoke-wayland-drag" $(pkg-config --cflags --libs wayland-client)
    export HEDDLEWORK_SMOKE_WAYLAND_DRAG=$runtime/smoke-wayland-drag
  fi
else
  export XDG_SESSION_TYPE=x11
  export DISPLAY=:99
  unset WAYLAND_DISPLAY WAYLAND_DEBUG
  setsid Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp +extension GLX +render -noreset > "$artifacts/xvfb-${decorations}.log" 2>&1 &
  xvfb_pid=$!
  for _ in $(seq 1 100); do
    xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
    kill -0 "$xvfb_pid" 2>/dev/null || { cat "$artifacts/xvfb-${decorations}.log" >&2; exit 1; }
    sleep 0.05
  done
  setsid dbus-run-session -- mutter --x11 --replace --sm-disable --display="$DISPLAY" > "$compositor_log" 2>&1 &
  compositor_pid=$!
  for _ in $(seq 1 240); do
    xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -qv 'not found' && break
    kill -0 "$compositor_pid" 2>/dev/null || { cat "$compositor_log" >&2; exit 1; }
    sleep 0.05
  done
  xprop -root _NET_SUPPORTING_WM_CHECK | grep -qv 'not found'
  for _ in $(seq 1 240); do
    xprop -root _NET_SUPPORTED 2>/dev/null | grep -q '_GTK_FRAME_EXTENTS' && break
    kill -0 "$compositor_pid" 2>/dev/null || { cat "$compositor_log" >&2; exit 1; }
    sleep 0.05
  done
  xprop -root _NET_SUPPORTED | grep -q '_GTK_FRAME_EXTENTS'
fi

timeout --preserve-status 120s bun scripts/linux-window-smoke.ts \
  --backend "$backend" \
  --compositor "$compositor" \
  --decorations "$decorations" \
  --report "$report"
