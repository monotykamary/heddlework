#!/bin/sh
# Mock `pi` for installer PTY tests.
# `node` is also satisfied by this mock via the same PATH entry (see symlink
# created by run-case.sh) so need_node passes without a real toolchain.
#
# A non-interactive run (`--print`, what the installer's round trip uses) is
# answered from the environment instead of a model, so a case can assert both
# what the installer asked for and how it reported the answer:
#   PI_MOCK_ARGV_LOG  file to append the full argv to
#   PI_MOCK_REPLY     what the "model" answers (default: pong)
#   PI_MOCK_STDERR    text to write to stderr (a credential failure, say)
#   PI_MOCK_EXIT      exit status (default: 0)
#   PI_MOCK_SLEEP     seconds to stall before answering

for arg in "$@"; do
  case "$arg" in
    --print|-p) PI_MOCK_PRINT=1 ;;
  esac
done

if [ -n "${PI_MOCK_PRINT:-}" ]; then
  [ -n "${PI_MOCK_ARGV_LOG:-}" ] && printf '%s\n' "$*" >> "$PI_MOCK_ARGV_LOG"
  [ -n "${PI_MOCK_STDERR:-}" ] && printf '%s\n' "$PI_MOCK_STDERR" >&2
  [ -n "${PI_MOCK_SLEEP:-}" ] && sleep "$PI_MOCK_SLEEP"
  # `${VAR-default}`, not `:-`, so an explicitly empty reply stays empty.
  printf '%s\n' "${PI_MOCK_REPLY-pong}"
  exit "${PI_MOCK_EXIT:-0}"
fi

case "$1" in
  --version) echo "pi 0.98.1-mock" ;;
  --help)
    # The flags the round trip looks for are listed the way Pi lists them.
    echo "usage: pi [--mode rpc] [path] [options]"
    echo "  --provider <name>              Provider name (default: google)"
    echo "  --model <pattern>              Model pattern or ID"
    echo "  --print, -p                    Non-interactive mode: process prompt and exit"
    echo "  --no-session                   Don't save session (ephemeral)"
    echo "  --no-tools, -nt                Disable all tools by default"
    echo "  --offline                      Disable startup network operations"
    ;;
  install) shift; echo "pi install $* (mock)" ;;
  *) echo "pi $* (mock)" ;;
esac
