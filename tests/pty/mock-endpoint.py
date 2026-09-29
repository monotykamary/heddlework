#!/usr/bin/env python3
"""Minimal OpenAI-compatible endpoint for the installer's connectivity check.

Serves what install.sh probes, so the PTY cases can prove the check both passes
and fails without a real model server:

    GET  /v1/models            -> the model ids given with --models
    POST /v1/chat/completions  -> a canned completion, 404 for an unknown model

Options:
    --port-file FILE   write the bound port here (binds 127.0.0.1:0)
    --models "a,b"     model ids the endpoint claims to serve
    --require-key KEY  answer 401 unless the bearer token matches
    --no-models        omit the model listing (404) so the chat fallback runs

Every request is logged to stdout as `[mock-endpoint] <METHOD> <path> -> <code>`
so a case can assert which route the probe used.
"""
import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port-file", required=True)
    parser.add_argument("--models", default="")
    parser.add_argument("--require-key", default="")
    parser.add_argument("--no-models", action="store_true")
    return parser.parse_args(argv)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    models = []
    require_key = ""
    no_models = False

    def log_message(self, fmt, *args):  # keep the default access log quiet
        pass

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        print(
            f"[mock-endpoint] {self.command} {self.path} -> {code}",
            file=sys.stdout,
            flush=True,
        )
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        if not self.require_key:
            return True
        header = self.headers.get("Authorization", "")
        if header == f"Bearer {self.require_key}":
            return True
        self._send(401, {"error": {"message": "invalid api key", "type": "invalid_request_error"}})
        return False

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's naming
        if not self.path.rstrip("/").endswith("/models"):
            self._send(404, {"error": {"message": "not found"}})
            return
        if not self._authorized():
            return
        if self.no_models:
            self._send(404, {"error": {"message": "not found"}})
            return
        self._send(
            200,
            {
                "object": "list",
                "data": [{"id": model, "object": "model"} for model in self.models],
            },
        )

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler's naming
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._send(404, {"error": {"message": "not found"}})
            return
        if not self._authorized():
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._send(400, {"error": {"message": "invalid json"}})
            return
        model = request.get("model", "")
        if model not in self.models:
            self._send(
                404,
                {
                    "error": {
                        "message": f"The model `{model}` does not exist",
                        "type": "invalid_request_error",
                        "code": "model_not_found",
                    }
                },
            )
            return
        self._send(
            200,
            {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "pong"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )


def main() -> int:
    args = parse_args(sys.argv[1:])
    Handler.models = [model.strip() for model in args.models.split(",") if model.strip()]
    Handler.require_key = args.require_key
    Handler.no_models = args.no_models

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    with open(args.port_file, "w", encoding="utf-8") as handle:
        handle.write(str(server.server_address[1]))
    print(
        f"[mock-endpoint] listening on 127.0.0.1:{server.server_address[1]} "
        f"models={Handler.models} no-models={Handler.no_models}",
        file=sys.stdout,
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
