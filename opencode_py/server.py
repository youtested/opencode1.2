"""Local authenticated server for phone, browser, SDK, and editor clients."""
from __future__ import annotations

import json
import os
import secrets
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, quote, unquote, urlsplit

from . import __version__
from . import session as default_session_store
from .config import Config
from .globals import Path as GPath
from .globals import resolve_worktree

MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_PROMPT_CHARS = 256 * 1024
MAX_EVENTS = 500


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item) for item in value]
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        try:
            return _jsonable(to_dict())
        except Exception:
            pass
    if hasattr(value, "__dataclass_fields__"):
        try:
            return {
                str(key): _jsonable(getattr(value, key))
                for key in value.__dataclass_fields__
            }
        except Exception:
            pass
    return str(value)


def _same_path(left: str | os.PathLike[str], right: str | os.PathLike[str]) -> bool:
    return os.path.normcase(os.path.abspath(os.fspath(left))) == os.path.normcase(
        os.path.abspath(os.fspath(right))
    )


def _valid_session_id(value: str) -> bool:
    return bool(value) and len(value) <= 128 and all(
        char.isalnum() or char in "-_" for char in value
    )


def _result_payload(result: Any) -> dict[str, Any]:
    return _jsonable(
        {
            "text": getattr(result, "text", "") or "",
            "reasoning": getattr(result, "reasoning", "") or "",
            "tool_calls_made": getattr(result, "tool_calls_made", 0) or 0,
            "usage": getattr(result, "usage", None),
            "provider_id": getattr(result, "provider_id", "") or "",
            "model_id": getattr(result, "model_id", "") or "",
            "finish_reason": getattr(result, "finish_reason", "") or "",
            "error": getattr(result, "error", "") or "",
            "network_failed": bool(getattr(result, "network_failed", False)),
        }
    )


class ServerSession:
    def __init__(self, state: ServerState, session: Any):
        self.state = state
        self.session = session
        self.engine: Any = None
        self._events: list[dict[str, Any]] = []
        self._next_sequence = 0
        self._condition = threading.Condition()
        self._turn_lock = threading.Lock()
        self._interrupt_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._active = False
        self._closed = False
        self._last_result: dict[str, Any] | None = None

    def attach(self, engine: Any) -> None:
        self.engine = engine
        try:
            self.engine.interrupt = self.interrupted
        except Exception:
            pass

    @property
    def active(self) -> bool:
        with self._condition:
            return self._active

    @property
    def closed(self) -> bool:
        with self._condition:
            return self._closed

    @property
    def cursor(self) -> int:
        with self._condition:
            return self._next_sequence

    def interrupted(self) -> bool:
        return self._interrupt_event.is_set() or self.closed

    def emit(self, event: dict[str, Any]) -> None:
        payload = _jsonable(dict(event))
        payload.setdefault("kind", "message")
        payload.setdefault("session_id", self.session.id)
        with self._condition:
            self._next_sequence += 1
            payload["seq"] = self._next_sequence
            payload.setdefault("time", time.time())
            self._events.append(payload)
            if len(self._events) > MAX_EVENTS:
                del self._events[: len(self._events) - MAX_EVENTS]
            self._condition.notify_all()

    def wait_events(self, after: int, timeout: float) -> list[dict[str, Any]] | None:
        with self._condition:
            ready = self._condition.wait_for(
                lambda: self._closed or any(event["seq"] > after for event in self._events),
                timeout,
            )
            if not ready:
                return None
            return [
                dict(event)
                for event in self._events
                if int(event.get("seq", 0)) > after
            ]

    def submit(self, prompt: str) -> dict[str, Any]:
        if not prompt.strip():
            return {"accepted": False, "error": "prompt must not be empty"}
        with self._turn_lock:
            if self._closed:
                return {"accepted": False, "error": "session is closed"}
            if self._active:
                try:
                    self.engine.queue_prompt(prompt)
                except Exception as exc:
                    return {"accepted": False, "error": str(exc)}
                self.emit({"kind": "prompt_queued", "text": prompt})
                return {"accepted": True, "queued": True, "event_cursor": self.cursor}
            self._interrupt_event.clear()
            self._active = True
            self.emit({"kind": "turn_started", "text": prompt})
            thread = threading.Thread(
                target=self._run_turn,
                args=(prompt,),
                name=f"opencode-server-{self.session.id[:8]}",
                daemon=True,
            )
            self._thread = thread
            thread.start()
            return {"accepted": True, "queued": False, "event_cursor": self.cursor}

    def _run_turn(self, prompt: str) -> None:
        result: Any = None
        try:
            result = self.engine.run_turn(prompt)
            try:
                history = self.engine.get_history()
            except Exception:
                history = None
            if history is not None:
                with self._condition:
                    self.session.messages = list(history)
            try:
                self.state.save_session(self.session)
            except Exception as exc:
                self.emit({"kind": "session_save_error", "error": str(exc)})
            payload = _result_payload(result)
            with self._condition:
                self._last_result = payload
            self.emit({"kind": "turn_complete", "result": payload})
        except Exception as exc:
            self.emit({"kind": "turn_error", "error": str(exc)})
        finally:
            with self._condition:
                self._active = False
                self._condition.notify_all()

    def abort(self) -> bool:
        self._interrupt_event.set()
        try:
            self.engine.abort()
        except Exception:
            pass
        return self.active

    def close(self) -> None:
        with self._condition:
            if self._closed:
                return
        self.abort()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)
        try:
            self.engine.close()
        except Exception:
            pass
        with self._condition:
            self._closed = True
            self._condition.notify_all()

    def payload(self, include_messages: bool = True) -> dict[str, Any]:
        with self._condition:
            data = _jsonable(self.session.to_dict())
            if not include_messages:
                data.pop("messages", None)
            data["runtime"] = {
                "active": self._active,
                "closed": self._closed,
                "event_cursor": self._next_sequence,
                "last_result": self._last_result,
            }
            return data


class ServerState:
    def __init__(
        self,
        cfg: Config,
        directory: str | Path,
        auth: Any = None,
        *,
        token: str,
        cors: list[str] | tuple[str, ...] | None = None,
        engine_factory: Callable[[Any, Callable[[dict[str, Any]], None]], Any] | None = None,
        session_store: Any = None,
    ):
        self.cfg = cfg
        self.directory = Path(resolve_worktree(Path(directory))).resolve()
        self.auth = auth
        self.token = token
        self.cors = tuple(str(item) for item in (cors or ()) if str(item).strip())
        self.engine_factory = engine_factory
        self.session_store = session_store or default_session_store
        self._sessions: dict[str, ServerSession] = {}
        self._lock = threading.RLock()
        self._closed = False
        self.httpd: Any = None
        self._web_html: bytes | None = None

    @property
    def closed(self) -> bool:
        return self._closed

    def request_shutdown(self) -> bool:
        if self._closed or self.httpd is None:
            return False

        def stop() -> None:
            time.sleep(0.05)
            try:
                self.httpd.shutdown()
            except Exception:
                pass

        threading.Thread(target=stop, name="opencode-server-stop", daemon=True).start()
        return True

    def _build_engine(
        self, session: Any, on_event: Callable[[dict[str, Any]], None]
    ) -> Any:
        if self.engine_factory is not None:
            return self.engine_factory(session, on_event)
        from .agent.loop import AgentLoop
        from .tools import build_registry

        return AgentLoop(
            cfg=self.cfg,
            registry=build_registry(self.cfg),
            directory=self.directory,
            auth=self.auth,
            agent=session.agent,
            provider_id=session.provider,
            model_id=session.model,
            session_id=session.id,
            on_event=on_event,
        )

    def _attach(self, session: Any) -> ServerSession:
        with self._lock:
            existing = self._sessions.get(session.id)
            if existing is not None:
                return existing
            runtime = ServerSession(self, session)
            engine = self._build_engine(session, runtime.emit)
            runtime.attach(engine)
            self._sessions[session.id] = runtime
            return runtime

    def create_session(
        self,
        *,
        title: str = "",
        agent: str | None = None,
        model: str | None = None,
        provider: str | None = None,
    ) -> ServerSession:
        if self._closed:
            raise RuntimeError("server is closed")
        session = self.session_store.new_session(
            directory=str(self.directory),
            provider=provider or self.cfg.provider,
            model=model or self.cfg.model,
            agent=agent or self.cfg.default_agent,
            title=str(title or "new session")[:120],
        )
        if not session.directory:
            session.directory = str(self.directory)
        return self._attach(session)

    def get_session(self, session_id: str) -> ServerSession | None:
        if not _valid_session_id(session_id):
            return None
        with self._lock:
            runtime = self._sessions.get(session_id)
            if runtime is not None:
                return runtime
        session = self.session_store.load_session(session_id)
        if session is None:
            return None
        if session.directory and not _same_path(session.directory, self.directory):
            return None
        if not session.directory:
            session.directory = str(self.directory)
        if not session.provider:
            session.provider = self.cfg.provider
        if not session.model:
            session.model = self.cfg.model
        if not session.agent:
            session.agent = self.cfg.default_agent
        return self._attach(session)

    def list_sessions(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for session in self.session_store.list_sessions(str(self.directory)):
            if session.id in seen:
                continue
            seen.add(session.id)
            out.append(self._summary(session))
        with self._lock:
            runtimes = list(self._sessions.values())
        for runtime in runtimes:
            if runtime.session.id in seen:
                for item in out:
                    if item.get("id") == runtime.session.id:
                        item["runtime"] = runtime.payload(include_messages=False)["runtime"]
                        break
            else:
                out.insert(0, runtime.payload(include_messages=False))
                seen.add(runtime.session.id)
        return out

    @staticmethod
    def _summary(session: Any) -> dict[str, Any]:
        data = _jsonable(session.to_dict())
        data.pop("messages", None)
        data["has_messages"] = bool(getattr(session, "has_messages", session.messages))
        return data

    def save_session(self, session: Any) -> Any:
        return self.session_store.save_session(session)

    def web_html(self) -> bytes:
        if self._web_html is None:
            path = Path(__file__).with_name("web") / "index.html"
            self._web_html = path.read_bytes()
        return self._web_html

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            runtimes = list(self._sessions.values())
        for runtime in runtimes:
            runtime.close()


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"opencode-py/{__version__}"

    @property
    def state(self) -> ServerState:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _cors(self) -> str | None:
        origin = self.headers.get("Origin")
        if not origin or not self.state.cors:
            return None
        if "*" in self.state.cors:
            return "*"
        return origin if origin in self.state.cors else None

    def _headers(self, content_type: str, length: int | None = None) -> None:
        self.send_header("Content-Type", content_type)
        if length is not None:
            self.send_header("Content-Length", str(length))
        origin = self._cors()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")

    def _send(self, status: int, body: bytes = b"", content_type: str = "application/json") -> None:
        self.send_response(status)
        self._headers(content_type, len(body))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(_jsonable(payload), ensure_ascii=False).encode("utf-8")
        self._send(status, body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        supplied = header[7:] if header.lower().startswith("bearer ") else ""
        supplied = supplied or self.headers.get("X-OpenCode-Token", "")
        return bool(supplied) and secrets.compare_digest(supplied, self.state.token)

    def _path(self) -> tuple[str, dict[str, list[str]]]:
        parsed = urlsplit(self.path)
        return parsed.path.rstrip("/") or "/", parse_qs(parsed.query)

    def _body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("invalid Content-Length") from exc
        if length < 0 or length > MAX_BODY_BYTES:
            raise ValueError("request body is too large")
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("request body must be valid JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("request body must be a JSON object")
        return value

    def _serve_web(self) -> None:
        try:
            body = self.state.web_html()
        except OSError:
            self._error(HTTPStatus.NOT_FOUND, "web interface is not installed")
            return
        self.send_response(HTTPStatus.OK)
        self._headers("text/html; charset=utf-8", len(body))
        self.end_headers()
        self.wfile.write(body)

    def _serve_events(self, runtime: ServerSession, after: int) -> None:
        self.send_response(HTTPStatus.OK)
        self._headers("text/event-stream; charset=utf-8")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.wfile.write(b"retry: 3000\n\n")
        self.wfile.flush()
        try:
            while True:
                events = runtime.wait_events(after, 15)
                if events is None:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                for event in events:
                    after = max(after, int(event.get("seq", after)))
                    data = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
                    self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
                self.wfile.flush()
                if runtime.closed:
                    break
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        self.close_connection = True

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self._headers("text/plain", 0)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-OpenCode-Token")
        origin = self._cors()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.end_headers()

    def do_GET(self) -> None:
        path, query = self._path()
        if path in ("/", "/index.html"):
            self._serve_web()
            return
        if path == "/api/v1/health":
            self._json(HTTPStatus.OK, {"status": "ok", "version": __version__})
            return
        if not self._authorized():
            self._error(HTTPStatus.UNAUTHORIZED, "missing or invalid server token")
            return
        parts = [unquote(part) for part in path.strip("/").split("/") if part]
        if parts == ["api", "v1", "info"]:
            self._json(
                HTTPStatus.OK,
                {
                    "version": __version__,
                    "api_version": "v1",
                    "directory": str(self.state.directory),
                    "capabilities": ["sessions", "streaming", "abort", "web_ui"],
                },
            )
            return
        if parts == ["api", "v1", "config"]:
            self._json(HTTPStatus.OK, self.state.cfg.as_dict(show_secrets=False))
            return
        if parts == ["api", "v1", "sessions"]:
            self._json(HTTPStatus.OK, {"sessions": self.state.list_sessions()})
            return
        if len(parts) == 4 and parts[:3] == ["api", "v1", "sessions"]:
            runtime = self.state.get_session(parts[3])
            if runtime is None:
                self._error(HTTPStatus.NOT_FOUND, "session not found")
                return
            self._json(HTTPStatus.OK, runtime.payload())
            return
        if len(parts) == 5 and parts[:3] == ["api", "v1", "sessions"] and parts[4] == "events":
            runtime = self.state.get_session(parts[3])
            if runtime is None:
                self._error(HTTPStatus.NOT_FOUND, "session not found")
                return
            try:
                after = int(query.get("after", [self.headers.get("Last-Event-ID", "0")])[0])
            except (TypeError, ValueError):
                after = 0
            self._serve_events(runtime, max(0, after))
            return
        self._error(HTTPStatus.NOT_FOUND, "endpoint not found")

    def do_POST(self) -> None:
        if not self._authorized():
            self._error(HTTPStatus.UNAUTHORIZED, "missing or invalid server token")
            return
        path, _query = self._path()
        parts = [unquote(part) for part in path.strip("/").split("/") if part]
        try:
            body = self._body()
        except ValueError as exc:
            self._error(HTTPStatus.BAD_REQUEST, str(exc))
            return
        if parts == ["api", "v1", "shutdown"]:
            stopping = self.state.request_shutdown()
            status = HTTPStatus.ACCEPTED if stopping else HTTPStatus.CONFLICT
            self._json(status, {"stopping": stopping})
            return
        if parts == ["api", "v1", "sessions"]:
            try:
                runtime = self.state.create_session(
                    title=str(body.get("title", "")),
                    agent=str(body.get("agent") or "") or None,
                    model=str(body.get("model") or "") or None,
                    provider=str(body.get("provider") or "") or None,
                )
            except Exception as exc:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))
                return
            self._json(HTTPStatus.CREATED, runtime.payload())
            return
        if len(parts) == 5 and parts[:3] == ["api", "v1", "sessions"] and parts[4] == "messages":
            runtime = self.state.get_session(parts[3])
            if runtime is None:
                self._error(HTTPStatus.NOT_FOUND, "session not found")
                return
            content = body.get("content", body.get("prompt", ""))
            if not isinstance(content, str):
                self._error(HTTPStatus.BAD_REQUEST, "content must be a string")
                return
            if len(content) > MAX_PROMPT_CHARS:
                self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "prompt is too large")
                return
            result = runtime.submit(content)
            status = HTTPStatus.ACCEPTED if result.get("accepted") else HTTPStatus.BAD_REQUEST
            self._json(status, result)
            return
        if len(parts) == 5 and parts[:3] == ["api", "v1", "sessions"] and parts[4] == "abort":
            runtime = self.state.get_session(parts[3])
            if runtime is None:
                self._error(HTTPStatus.NOT_FOUND, "session not found")
                return
            self._json(HTTPStatus.ACCEPTED, {"aborted": runtime.abort()})
            return
        self._error(HTTPStatus.NOT_FOUND, "endpoint not found")


class _HTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def make_server(state: ServerState, host: str = "127.0.0.1", port: int = 0) -> _HTTPServer:
    httpd = _HTTPServer((host, port), _Handler)
    httpd.state = state  # type: ignore[attr-defined]
    state.httpd = httpd
    return httpd


def _cors_values(value: str | list[str] | tuple[str, ...] | None) -> list[str]:
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return [str(item).strip() for item in (value or ()) if str(item).strip()]


def _server_config(cfg: Config) -> dict[str, Any]:
    value = getattr(cfg, "server", None)
    return value if isinstance(value, dict) else {}


def serve(
    cfg: Config,
    directory: str | Path,
    auth: Any = None,
    *,
    host: str | None = None,
    port: int | None = None,
    token: str | None = None,
    cors: str | list[str] | tuple[str, ...] | None = None,
    open_browser: bool = False,
) -> ServerState:
    GPath.init()
    config = _server_config(cfg)
    host = host or os.environ.get("OPENCODE_SERVER_HOST") or str(config.get("host") or "127.0.0.1")
    raw_port = port if port is not None else os.environ.get("OPENCODE_SERVER_PORT", config.get("port", 0))
    try:
        port = int(raw_port)
    except (TypeError, ValueError):
        port = 0
    if port < 0 or port > 65535:
        raise ValueError("server port must be between 0 and 65535")
    token = token or os.environ.get("OPENCODE_SERVER_TOKEN") or secrets.token_urlsafe(32)
    if len(token) < 16:
        raise ValueError("server token must be at least 16 characters")
    cors_values = _cors_values(cors if cors is not None else config.get("cors", ()))
    state = ServerState(cfg, directory, auth, token=token, cors=cors_values)
    httpd = make_server(state, host, port)
    bound_host, bound_port = httpd.server_address[:2]
    display_host = "127.0.0.1" if bound_host in ("0.0.0.0", "::") else bound_host
    url = f"http://{display_host}:{bound_port}/"
    print(f"OpenCode server listening on {url}", flush=True)
    print(f"Server token: {token}", flush=True)
    if open_browser:
        browser_url = f"{url}#token={quote(token, safe='')}"
        threading.Timer(0.2, lambda: webbrowser.open(browser_url)).start()
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        state.close()
    return state


__all__ = ["ServerSession", "ServerState", "make_server", "serve"]
