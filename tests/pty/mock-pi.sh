#!/bin/sh
# Mock `pi` for installer PTY tests.
# `node` is also satisfied by this mock via the same PATH entry (see symlink
# created by run-case.sh) so need_node passes without a real toolchain.
#
# A non-interactive run (`--print`, what the installer's round trips use) is
# answered from the environment instead of a model, so a case can assert both
# what the installer asked for and how it reported the answer:
#   PI_MOCK_ARGV_LOG  file to append the full argv to
#   PI_MOCK_REPLY     what the "model" answers (default: pong)
#   PI_MOCK_STDERR    text to write to stderr (a credential failure, say)
#   PI_MOCK_EXIT      exit status (default: 0)
#   PI_MOCK_SLEEP     seconds to stall before answering
#
# A run the installer makes with `--exclude-tools` is answered as a JSON event
# stream instead, shaped like the one Pi emits, so a case can choose which
# evidence the installer finds in it. The prompt tells the two apart: the tool
# check names heddlework-tool-probe.txt, the agent turn names
# heddlework-agent-probe.txt.
#
# The tool check (a read-only run) answers with the probe file's contents, the
# way the chat phase answers pong — a case about something else still gets an
# endpoint that works:
#   PI_MOCK_TOOL_READ    file to read back: the stream carries a tool call and the
#                        answer is that file's contents, which the installer
#                        checks for, since only a tool call can reveal them
#   PI_MOCK_TOOL_CALL    non-empty: the stream carries a tool call but no file is
#                        read — the shape a pi-fabric session produces, where the
#                        only tool cannot read the probe file
#   PI_MOCK_TOOL_REPLY   answer with no tool call at all: the model that only
#                        chats (default: read the probe file, as above)
#
# The agent turn plays the whole session: the mock emits a read tool call and an
# edit tool call and *performs* the edit on the probe file in the working
# directory, the way Pi would on the model's behalf. A case can narrow that:
#   PI_MOCK_AGENT_NO_EDIT  non-empty: a read-only turn — a tool call, an answer,
#                          and the file left untouched (a session that cannot
#                          finish an edit)
#   PI_MOCK_AGENT_BLIND    non-empty: write the edit line over the probe file
#                          instead of after its contents, so the token the turn
#                          had to read back does not survive
#   PI_MOCK_AGENT_LINE     the line the edit adds (default: the installer's own)
#   PI_MOCK_AGENT_REPLY    what the turn answers (default: done)
#
# Both JSON runs share the failure knobs:
#   PI_MOCK_TOOL_STDERR  text to write to stderr before the stream (an endpoint
#                        rejecting the tools field, say)
#   PI_MOCK_TOOL_EXIT    exit status for the run (default: 0)
#   PI_MOCK_LEGACY_HELP  non-empty: --help omits --mode and --exclude-tools, so
#                        both JSON checks should skip themselves
#
# A mock is not a JSON library: text is escaped for quotes and backslashes only,
# and the probe path it claims to have read is the one the installer writes.

PI_MOCK_AGENT_PROBE_FILE=${PI_MOCK_AGENT_PROBE_FILE:-heddlework-agent-probe.txt}
PI_MOCK_AGENT_LINE=${PI_MOCK_AGENT_LINE-'heddlework agent turn: edited'}

PI_MOCK_TOOL_RUN=''
PI_MOCK_AGENT_RUN=''
for arg in "$@"; do
  case "$arg" in
    --print|-p) PI_MOCK_PRINT=1 ;;
    --exclude-tools|-xt) PI_MOCK_TOOL_RUN=1 ;;
    *"$PI_MOCK_AGENT_PROBE_FILE"*) PI_MOCK_AGENT_RUN=1 ;;
  esac
done

# json_escape <text>
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if [ -n "${PI_MOCK_PRINT:-}" ]; then
  [ -n "${PI_MOCK_ARGV_LOG:-}" ] && printf '%s\n' "$*" >> "$PI_MOCK_ARGV_LOG"
  [ -n "${PI_MOCK_TOOL_STDERR:-}" ] && printf '%s\n' "$PI_MOCK_TOOL_STDERR" >&2
  if [ -n "${PI_MOCK_TOOL_RUN:-}" ]; then
    [ -n "${PI_MOCK_TOOL_EXIT:-}" ] && [ "${PI_MOCK_TOOL_EXIT:-0}" != 0 ] && exit "$PI_MOCK_TOOL_EXIT"
    if [ -n "${PI_MOCK_AGENT_RUN:-}" ]; then
      # The agent turn: the mock is the model *and* the tools it calls, so it
      # edits the probe file itself. A failing edit leaves it alone.
      agent_edit=''
      if [ -n "${PI_MOCK_AGENT_NO_EDIT:-}" ]; then
        agent_answer=${PI_MOCK_AGENT_REPLY-I have not changed the file.}
      else
        agent_before=$(cat "$PI_MOCK_AGENT_PROBE_FILE" 2>/dev/null)
        if [ -n "${PI_MOCK_AGENT_BLIND:-}" ]; then
          printf '%s\n' "$PI_MOCK_AGENT_LINE" > "$PI_MOCK_AGENT_PROBE_FILE"
        else
          printf '%s\n%s\n' "$agent_before" "$PI_MOCK_AGENT_LINE" > "$PI_MOCK_AGENT_PROBE_FILE"
        fi
        agent_edit=1
        agent_answer=${PI_MOCK_AGENT_REPLY-done}
      fi
      printf '%s\n' '{"type":"session","version":3,"id":"mock-session","timestamp":"1970-01-01T00:00:00.000Z","cwd":"."}'
      printf '%s\n' '{"type":"toolcall_start","toolCallId":"call_mock_read","toolName":"read"}'
      printf '%s\n' '{"type":"tool_execution_start","toolCallId":"call_mock_read","toolName":"read"}'
      printf '%s\n' '{"type":"tool_execution_end","toolCallId":"call_mock_read","toolName":"read","isError":false}'
      if [ -n "$agent_edit" ]; then
        printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","toolName":"edit","arguments":{"path":"'"$PI_MOCK_AGENT_PROBE_FILE"'"}}]}}'
        printf '%s\n' '{"type":"toolcall_start","toolCallId":"call_mock_edit","toolName":"edit"}'
        printf '%s\n' '{"type":"tool_execution_start","toolCallId":"call_mock_edit","toolName":"edit"}'
        printf '%s\n' '{"type":"tool_execution_end","toolCallId":"call_mock_edit","toolName":"edit","isError":false}'
      fi
      printf '{"type":"text_end","text":"%s"}\n' "$(json_escape "$agent_answer")"
      printf '%s\n' '{"type":"agent_settled"}'
      exit 0
    fi
    tool_calls=''
    if [ -n "${PI_MOCK_TOOL_READ:-}" ]; then
      tool_answer=$(cat "$PI_MOCK_TOOL_READ" 2>/dev/null | tr -d '\n')
      tool_calls=1
    elif [ -n "${PI_MOCK_TOOL_CALL:-}" ]; then
      tool_answer=${PI_MOCK_TOOL_REPLY-I cannot read files.}
      tool_calls=1
    elif [ -n "${PI_MOCK_TOOL_REPLY:-}" ]; then
      tool_answer=$PI_MOCK_TOOL_REPLY
    else
      # The default: a model that read the probe file the installer wrote into
      # its working directory.
      tool_answer=$(cat heddlework-tool-probe.txt 2>/dev/null | tr -d '\n')
      tool_calls=1
    fi
    printf '%s\n' '{"type":"session","version":3,"id":"mock-session","timestamp":"1970-01-01T00:00:00.000Z","cwd":"."}'
    if [ -n "$tool_calls" ]; then
      printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","toolName":"read","arguments":{"path":"heddlework-tool-probe.txt"}}]}}'
      printf '%s\n' '{"type":"toolcall_start","toolCallId":"call_mock_1","toolName":"read"}'
      printf '%s\n' '{"type":"toolcall_end","toolCallId":"call_mock_1","toolName":"read"}'
      printf '%s\n' '{"type":"tool_execution_start","toolCallId":"call_mock_1","toolName":"read"}'
      printf '%s\n' '{"type":"tool_execution_end","toolCallId":"call_mock_1","toolName":"read","isError":false}'
    fi
    printf '{"type":"text_end","text":"%s"}\n' "$(json_escape "$tool_answer")"
    printf '%s\n' '{"type":"agent_settled"}'
    exit "${PI_MOCK_TOOL_EXIT:-0}"
  fi
  [ -n "${PI_MOCK_STDERR:-}" ] && printf '%s\n' "$PI_MOCK_STDERR" >&2
  [ -n "${PI_MOCK_SLEEP:-}" ] && sleep "$PI_MOCK_SLEEP"
  # `${VAR-default}`, not `:-`, so an explicitly empty reply stays empty.
  printf '%s\n' "${PI_MOCK_REPLY-pong}"
  exit "${PI_MOCK_EXIT:-0}"
fi

case "$1" in
  --version) echo "pi 0.98.1-mock" ;;
  --help)
    # The flags the round trips look for are listed the way Pi lists them;
    # PI_MOCK_LEGACY_HELP drops the two both JSON checks need, the way an older
    # build would.
    echo "usage: pi [path] [options]"
    echo "  --provider <name>              Provider name (default: google)"
    echo "  --model <pattern>              Model pattern or ID"
    echo "  --print, -p                    Non-interactive mode: process prompt and exit"
    echo "  --no-session                   Don't save session (ephemeral)"
    echo "  --no-tools, -nt                Disable all tools by default"
    if [ -z "${PI_MOCK_LEGACY_HELP:-}" ]; then
      echo "  --mode <mode>                  Output mode: text (default), json, or rpc"
      echo "  --exclude-tools, -xt <tools>   Comma-separated denylist of tool names to disable"
    fi
    echo "  --offline                      Disable startup network operations"
    ;;
  install) shift; echo "pi install $* (mock)" ;;
  *) echo "pi $* (mock)" ;;
esac
