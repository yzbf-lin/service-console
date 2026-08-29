"""Multi-instance Jenkins configuration and remote API integration."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import os
import re
import ssl
import sys
import tempfile
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from threading import RLock
from typing import Any, Protocol
from urllib.parse import parse_qsl, quote, urljoin, urlsplit, urlunsplit

import httpx
import keyring

_QUEUE_ITEM_PATTERN = re.compile(r"/queue/item/(?P<id>\d+)(?:/|$)")
_CONTROL_CHARACTER_PATTERN = re.compile(r"[\x00-\x1f\x7f]")
_HTTP_HEADER_NAME_PATTERN = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_CRUMB_VALUE_PATTERN = re.compile(r"^[\x21-\x7e]+$")
_RESERVED_CRUMB_HEADERS = frozenset(
    {
        "accept",
        "authorization",
        "connection",
        "content-length",
        "cookie",
        "host",
        "proxy-authorization",
        "transfer-encoding",
        "user-agent",
    }
)
_MAX_LOG_CHUNK_BYTES = 2 * 1024 * 1024
_MAX_BUILD_FORM_BYTES = 1024 * 1024
_MAX_BUILD_FORM_OPTIONS = 5_000
_MAX_ACTIVE_CHOICE_SCRIPT_BYTES = 256 * 1024
_MAX_PARAMETER_VALUE_LENGTH = 16_384
_MAX_MULTI_SELECT_VALUES = 5_000
_MIN_BUILD_FORM_TIMEOUT_SECONDS = 30
_MAX_BUILD_FORM_TIMEOUT_SECONDS = 60
_HTML_VOID_ELEMENTS = frozenset(
    {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }
)
_MISSING = object()


@dataclass(frozen=True, slots=True)
class _BuildFormParameter:
    choices: tuple[str, ...] | None
    selected: tuple[str, ...]
    multiple: bool
    hidden_value: str | None
    has_hidden_value: bool
    has_select: bool
    fill_url: str | None


@dataclass(frozen=True, slots=True)
class _ActiveChoiceBinding:
    name: str
    references: tuple[str, ...]
    endpoint: str
    crumb: str
    reference_only: bool


@dataclass(frozen=True, slots=True)
class _BuildFormSnapshot:
    parameters: dict[str, _BuildFormParameter]
    active_choices: dict[str, _ActiveChoiceBinding]
    referer: str


@dataclass(slots=True)
class _PendingBuildFormParameter:
    depth: int
    name: str | None = None
    choices: list[str] | None = None
    selected: list[str] | None = None
    multiple: bool = False
    hidden_value: object = _MISSING
    select_depth: int | None = None
    option_depth: int | None = None
    option_value: str | None = None
    option_selected: bool = False
    option_disabled: bool = False
    option_text: list[str] | None = None
    option_count: int = 0
    fill_url: str | None = None


class _JenkinsBuildFormParser(HTMLParser):
    """Extract only Jenkins' structured parameter controls from a bounded HTML document."""

    def __init__(self, expected_names: set[str]) -> None:
        super().__init__(convert_charrefs=True)
        self.expected_names = expected_names
        self.parameters: dict[str, _BuildFormParameter] = {}
        self._stack: list[str] = []
        self._form_depth: int | None = None
        self._parameter: _PendingBuildFormParameter | None = None
        self._form_closed = False
        self._invalid = False

    @property
    def has_valid_parameter_form(self) -> bool:
        return self._form_closed and not self._invalid and bool(self.parameters)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.casefold()
        attributes = {name.casefold(): value for name, value in attrs}
        depth = len(self._stack) + 1
        if normalized_tag not in _HTML_VOID_ELEMENTS:
            self._stack.append(normalized_tag)

        if normalized_tag == "form" and self._form_depth is None and _is_parameter_form(attributes):
            self._form_depth = depth
            self._form_closed = False
            return
        if self._form_depth is None:
            return

        if (
            normalized_tag == "div"
            and str(attributes.get("name") or "").casefold() == "parameter"
            and self._parameter is None
        ):
            self._parameter = _PendingBuildFormParameter(depth=depth)
            return

        parameter = self._parameter
        if parameter is None:
            return
        if normalized_tag == "input":
            input_name = str(attributes.get("name") or "").casefold()
            value = attributes.get("value")
            if input_name == "name" and isinstance(value, str):
                parameter.name = value
            elif (
                input_name == "value"
                and str(attributes.get("type") or "").casefold() == "hidden"
                and isinstance(value, str)
                and len(value) <= _MAX_PARAMETER_VALUE_LENGTH
            ):
                parameter.hidden_value = value
            elif (
                input_name == "value"
                and str(attributes.get("type") or "").casefold() in {"checkbox", "radio"}
                and isinstance(value, str)
                and len(value) <= _MAX_PARAMETER_VALUE_LENGTH
            ):
                if parameter.choices is None:
                    parameter.choices = []
                    parameter.selected = []
                if value not in parameter.choices and len(parameter.choices) < _MAX_BUILD_FORM_OPTIONS:
                    parameter.choices.append(value)
                if "checked" in attributes and value not in (parameter.selected or []):
                    parameter.selected.append(value)
                if str(attributes.get("type") or "").casefold() == "checkbox":
                    parameter.multiple = True
            return
        if normalized_tag == "select" and str(attributes.get("name") or "").casefold() == "value":
            if parameter.select_depth is None:
                parameter.select_depth = depth
                parameter.choices = []
                parameter.selected = []
                parameter.multiple = "multiple" in attributes
                fill_url = attributes.get("fillurl")
                if isinstance(fill_url, str) and len(fill_url) <= 4_096:
                    parameter.fill_url = fill_url
            return
        if normalized_tag == "option" and parameter.select_depth is not None:
            self._finish_option(parameter)
            parameter.option_count += 1
            if parameter.option_count > _MAX_BUILD_FORM_OPTIONS:
                self._invalid = True
            parameter.option_depth = depth
            parameter.option_value = attributes.get("value")
            if (
                isinstance(parameter.option_value, str)
                and len(parameter.option_value) > _MAX_PARAMETER_VALUE_LENGTH
            ):
                self._invalid = True
            parameter.option_selected = "selected" in attributes
            parameter.option_disabled = "disabled" in attributes
            parameter.option_text = []

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag.casefold() not in _HTML_VOID_ELEMENTS:
            self.handle_endtag(tag)

    def handle_data(self, data: str) -> None:
        parameter = self._parameter
        if parameter is None or parameter.option_depth is None or parameter.option_text is None:
            return
        current_length = sum(len(part) for part in parameter.option_text)
        if current_length + len(data) > _MAX_PARAMETER_VALUE_LENGTH:
            self._invalid = True
        if current_length < _MAX_PARAMETER_VALUE_LENGTH:
            parameter.option_text.append(data[: _MAX_PARAMETER_VALUE_LENGTH - current_length])

    def handle_endtag(self, tag: str) -> None:
        normalized_tag = tag.casefold()
        try:
            stack_index = len(self._stack) - 1 - self._stack[::-1].index(normalized_tag)
        except ValueError:
            return
        closing_depth = stack_index + 1
        parameter = self._parameter
        if parameter is not None:
            if parameter.option_depth is not None and parameter.option_depth >= closing_depth:
                self._finish_option(parameter)
            if parameter.select_depth is not None and parameter.select_depth >= closing_depth:
                if normalized_tag != "select" or parameter.select_depth != closing_depth:
                    self._invalid = True
                parameter.select_depth = None
            if parameter.depth >= closing_depth:
                if normalized_tag == "div" and parameter.depth == closing_depth:
                    self._finish_parameter(parameter)
                else:
                    self._invalid = True
                self._parameter = None
        if self._form_depth is not None and self._form_depth >= closing_depth:
            if normalized_tag == "form" and self._form_depth == closing_depth:
                self._form_closed = True
            else:
                self._invalid = True
            self._form_depth = None
        del self._stack[stack_index:]

    def close(self) -> None:
        super().close()
        if self._parameter is not None or self._form_depth is not None:
            self._invalid = True
        self._parameter = None
        self._form_depth = None

    @staticmethod
    def _finish_option(parameter: _PendingBuildFormParameter) -> None:
        if parameter.option_depth is None:
            return
        value = parameter.option_value
        if value is None:
            value = "".join(parameter.option_text or []).strip()
        choices = parameter.choices
        selected = parameter.selected
        if (
            not parameter.option_disabled
            and choices is not None
            and selected is not None
            and len(value) <= _MAX_PARAMETER_VALUE_LENGTH
            and value not in choices
            and len(choices) < _MAX_BUILD_FORM_OPTIONS
        ):
            choices.append(value)
            if parameter.option_selected:
                selected.append(value)
        parameter.option_depth = None
        parameter.option_value = None
        parameter.option_selected = False
        parameter.option_disabled = False
        parameter.option_text = None

    def _finish_parameter(self, parameter: _PendingBuildFormParameter) -> None:
        name = parameter.name
        if (
            not isinstance(name, str)
            or name not in self.expected_names
            or (parameter.choices is None and parameter.hidden_value is _MISSING)
        ):
            return
        parsed = _BuildFormParameter(
            choices=tuple(parameter.choices) if parameter.choices is not None else None,
            selected=tuple(parameter.selected or ()),
            multiple=parameter.multiple,
            hidden_value=(parameter.hidden_value if isinstance(parameter.hidden_value, str) else None),
            has_hidden_value=parameter.hidden_value is not _MISSING,
            has_select=parameter.choices is not None,
            fill_url=parameter.fill_url,
        )
        existing = self.parameters.get(name)
        if existing is None or (parsed.has_select and not existing.has_select):
            self.parameters[name] = parsed


class _JenkinsActiveChoiceScriptParser(HTMLParser):
    """Extract bounded Active Choices Stapler bindings from inline build-form scripts."""

    def __init__(self, expected_names: set[str]) -> None:
        super().__init__(convert_charrefs=True)
        self.expected_names = expected_names
        self.bindings: dict[str, _ActiveChoiceBinding] = {}
        self._script_depth = 0
        self._script_parts: list[str] = []
        self._script_bytes = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag.casefold() == "script":
            self._script_depth += 1
            if self._script_depth == 1:
                self._script_parts = []
                self._script_bytes = 0

    def handle_data(self, data: str) -> None:
        if self._script_depth != 1 or self._script_bytes >= _MAX_ACTIVE_CHOICE_SCRIPT_BYTES:
            return
        encoded = data.encode("utf-8", errors="ignore")
        remaining = _MAX_ACTIVE_CHOICE_SCRIPT_BYTES - self._script_bytes
        self._script_parts.append(encoded[:remaining].decode("utf-8", errors="ignore"))
        self._script_bytes += min(len(encoded), remaining)

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() != "script" or self._script_depth == 0:
            return
        if self._script_depth == 1:
            self._finish_script("".join(self._script_parts))
            self._script_parts = []
            self._script_bytes = 0
        self._script_depth -= 1

    def _finish_script(self, script: str) -> None:
        constructor = re.search(
            r"new\s+UnoChoice\.(CascadeParameter|DynamicReferenceParameter)\(\s*(['\"])(.*?)\2",
            script,
            re.DOTALL,
        )
        proxy = re.search(
            r"makeStaplerProxy\(\s*(['\"])(.*?)\1\s*,\s*(['\"])(.*?)\3\s*,\s*\[([^]]+)]",
            script,
            re.DOTALL,
        )
        if constructor is None or proxy is None:
            return
        name = _decode_js_string(constructor.group(3), constructor.group(2))
        endpoint = _decode_js_string(proxy.group(2), proxy.group(1))
        crumb = _decode_js_string(proxy.group(4), proxy.group(3))
        methods = proxy.group(5)
        if (
            name not in self.expected_names
            or re.fullmatch(
                r"/(?:[0-9A-Za-z._~-]+/)*\$stapler/bound/[0-9A-Za-z-]{1,128}",
                endpoint,
            )
            is None
            or not crumb
            or len(crumb) > 4_096
            or _CRUMB_VALUE_PATTERN.fullmatch(crumb) is None
            or "doUpdate" not in methods
            or "getChoicesForUI" not in methods
        ):
            return
        references: list[str] = []
        for match in re.finditer(
            r"referencedParameters\.push\(\s*(['\"])(.*?)\1\s*\)",
            script,
            re.DOTALL,
        ):
            reference = _decode_js_string(match.group(2), match.group(1))
            if reference in self.expected_names and reference not in references:
                references.append(reference)
        self.bindings[name] = _ActiveChoiceBinding(
            name=name,
            references=tuple(references),
            endpoint=endpoint,
            crumb=crumb,
            reference_only=constructor.group(1) == "DynamicReferenceParameter",
        )


def _decode_js_string(value: str, quote_character: str) -> str:
    if quote_character == '"':
        try:
            decoded = json.loads(f'"{value}"')
            return decoded if isinstance(decoded, str) else ""
        except json.JSONDecodeError:
            return ""
    return value.replace(r"\'", "'").replace(r"\\", "\\")


def _is_parameter_form(attributes: Mapping[str, str | None]) -> bool:
    method = str(attributes.get("method") or "").casefold()
    name = str(attributes.get("name") or "").casefold()
    action = str(attributes.get("action") or "")
    action_path = urlsplit(action).path.rstrip("/").casefold()
    return method == "post" and (
        name == "parameters" or action_path == "build" or action_path.endswith("/build")
    )


class JenkinsApiError(Exception):
    """A safe, user-facing Jenkins integration failure."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True, slots=True)
class JenkinsInstance:
    """Non-sensitive, persistent definition of one Jenkins controller."""

    id: str
    name: str
    base_url: str
    username: str
    ca_bundle: str | None = None
    enabled: bool = True
    request_timeout: float = 15.0

    def __post_init__(self) -> None:
        normalized_id = str(self.id).strip()
        normalized_name = str(self.name).strip()
        normalized_username = str(self.username).strip()
        normalized_ca = str(self.ca_bundle).strip() if self.ca_bundle else None

        if not normalized_id or _CONTROL_CHARACTER_PATTERN.search(normalized_id):
            raise ValueError("Jenkins instance id is invalid")
        if not normalized_name or _CONTROL_CHARACTER_PATTERN.search(normalized_name):
            raise ValueError("Jenkins instance name is required")
        if not normalized_username or _CONTROL_CHARACTER_PATTERN.search(normalized_username):
            raise ValueError("Jenkins username is required")
        if ":" in normalized_username:
            raise ValueError("Jenkins username must not contain ':'")
        if normalized_ca and _CONTROL_CHARACTER_PATTERN.search(normalized_ca):
            raise ValueError("Jenkins CA bundle path is invalid")

        timeout = float(self.request_timeout)
        if not math.isfinite(timeout) or timeout < 1 or timeout > 120:
            raise ValueError("Jenkins request timeout must be between 1 and 120 seconds")

        object.__setattr__(self, "id", normalized_id)
        object.__setattr__(self, "name", normalized_name)
        object.__setattr__(self, "base_url", _normalize_base_url(self.base_url))
        object.__setattr__(self, "username", normalized_username)
        object.__setattr__(self, "ca_bundle", normalized_ca)
        object.__setattr__(self, "enabled", bool(self.enabled))
        object.__setattr__(self, "request_timeout", timeout)

    def to_dict(self) -> dict[str, object]:
        """Serialize only non-sensitive fields."""

        return {
            "id": self.id,
            "name": self.name,
            "base_url": self.base_url,
            "username": self.username,
            "ca_bundle": self.ca_bundle,
            "enabled": self.enabled,
            "request_timeout": self.request_timeout,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> JenkinsInstance:
        return cls(
            id=value["id"],
            name=value["name"],
            base_url=value["base_url"],
            username=value["username"],
            ca_bundle=value.get("ca_bundle"),
            enabled=value.get("enabled", True),
            request_timeout=value.get("request_timeout", 15.0),
        )


def _normalize_base_url(value: object) -> str:
    raw_url = str(value).strip()
    if not raw_url or _CONTROL_CHARACTER_PATTERN.search(raw_url):
        raise ValueError("Jenkins base URL is required")
    try:
        parsed = urlsplit(raw_url)
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError as exc:
        raise ValueError("Jenkins base URL is invalid") from exc
    if parsed.scheme.lower() not in {"http", "https"} or not hostname:
        raise ValueError("Jenkins base URL must use http or https")
    if any(character.isspace() for character in hostname):
        raise ValueError("Jenkins base URL contains an invalid hostname")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Jenkins base URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("Jenkins base URL must not contain a query or fragment")
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme.lower(), parsed.netloc, path, "", ""))


def _jenkins_relative_endpoint(instance: JenkinsInstance, path: str) -> str:
    context_path = urlsplit(instance.base_url).path.rstrip("/")
    if context_path and (path == context_path or path.startswith(f"{context_path}/")):
        return path[len(context_path) :] or "/"
    return path


class JenkinsInstanceStore:
    """Atomically persist Jenkins instance metadata without credentials."""

    def __init__(self, data_dir: str | Path) -> None:
        self.data_dir = Path(data_dir).expanduser()
        self.path = self.data_dir / "jenkins-instances.json"
        self._lock = RLock()
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def load(self) -> dict[str, JenkinsInstance]:
        with self._lock:
            if not self.path.exists():
                return {}
            try:
                payload = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ValueError(f"failed to load Jenkins instances: {exc}") from exc

        values = payload.get("instances", []) if isinstance(payload, dict) else None
        if not isinstance(values, list):
            raise ValueError("Jenkins instances must contain a JSON list")  # noqa: TRY004

        instances: dict[str, JenkinsInstance] = {}
        for raw_instance in values:
            if not isinstance(raw_instance, dict):
                raise ValueError("each Jenkins instance must be a JSON object")  # noqa: TRY004
            instance = JenkinsInstance.from_dict(raw_instance)
            if instance.id in instances:
                raise ValueError(f"duplicate Jenkins instance id: {instance.id}")
            instances[instance.id] = instance
        return instances

    def save(self, instances: Mapping[str, JenkinsInstance]) -> None:
        payload = {
            "version": 1,
            "instances": [
                instance.to_dict()
                for instance in sorted(instances.values(), key=lambda item: item.name.casefold())
            ],
        }
        encoded = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"

        with self._lock:
            temporary_path: str | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    "w",
                    encoding="utf-8",
                    dir=self.data_dir,
                    prefix=".jenkins-instances-",
                    suffix=".tmp",
                    delete=False,
                ) as temporary:
                    temporary_path = temporary.name
                    temporary.write(encoded)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_path, self.path)
            finally:
                if temporary_path is not None:
                    Path(temporary_path).unlink(missing_ok=True)


class CredentialStore(Protocol):
    """Synchronous credential store contract, injectable for tests."""

    def get(self, instance_id: str) -> str | None: ...

    def set(self, instance_id: str, token: str) -> None: ...

    def delete(self, instance_id: str) -> None: ...


class KeyringCredentialStore:
    """Use a native secure keyring, with memory-only fallback for this session."""

    def __init__(self, service_name: str = "service-console.jenkins") -> None:
        self.service_name = service_name
        self._session_tokens: dict[str, str] = {}
        self._lock = RLock()

    def get(self, instance_id: str) -> str | None:
        with self._lock:
            session_token = self._session_tokens.get(instance_id)
            if session_token is not None:
                return session_token
            backend = self._secure_backend()
            if backend is None:
                return None
            try:
                return backend.get_password(self.service_name, instance_id)
            except Exception as exc:
                raise JenkinsApiError(409, "Secure credential store could not be read") from exc

    def set(self, instance_id: str, token: str) -> None:
        normalized_token = _normalize_token(token)
        with self._lock:
            backend = self._secure_backend()
            if backend is not None:
                try:
                    backend.set_password(self.service_name, instance_id, normalized_token)
                except Exception as exc:
                    raise JenkinsApiError(409, "Secure credential store could not save the token") from exc
                self._session_tokens.pop(instance_id, None)
                return
            # Never use a plaintext fallback. The token remains valid only for this process.
            self._session_tokens[instance_id] = normalized_token

    def delete(self, instance_id: str) -> None:
        with self._lock:
            self._session_tokens.pop(instance_id, None)
            backend = self._secure_backend()
            if backend is None:
                return
            try:
                existing = backend.get_password(self.service_name, instance_id)
            except Exception as exc:
                raise JenkinsApiError(409, "Secure credential store could not be read") from exc
            if existing is None:
                return
            try:
                backend.delete_password(self.service_name, instance_id)
            except Exception as exc:
                raise JenkinsApiError(409, "Secure credential store could not delete the token") from exc

    @staticmethod
    def _secure_backend() -> Any | None:
        try:
            backend = keyring.get_keyring()
        except Exception:  # noqa: BLE001 - backend discovery failures require memory-only fallback.
            return None

        module = type(backend).__module__.casefold()
        class_name = type(backend).__name__.casefold()
        if any(marker in module or marker in class_name for marker in ("fail", "null", "plaintext")):
            return None
        if "chainer" in module or "chainer" in class_name:
            return None
        if sys.platform == "darwin":
            return backend if module.startswith("keyring.backends.macos") else None
        if os.name == "nt":
            return backend if module.startswith("keyring.backends.windows") else None
        secure_modules = (
            "keyring.backends.secretservice",
            "keyring.backends.kwallet",
            "keyring.backends.libsecret",
        )
        return backend if module.startswith(secure_modules) else None


def _normalize_token(token: object) -> str:
    value = str(token).strip()
    if not value:
        raise ValueError("Jenkins API token must not be empty")
    if _CONTROL_CHARACTER_PATTERN.search(value):
        raise ValueError("Jenkins API token contains invalid control characters")
    return value


ClientFactory = Callable[[ssl.SSLContext], httpx.AsyncClient]


class JenkinsGateway:
    """Long-lived async Jenkins client pool with strict TLS verification."""

    def __init__(self, client_factory: ClientFactory | None = None) -> None:
        self._client_factory = client_factory or self._default_client_factory
        self._clients: dict[str, httpx.AsyncClient] = {}
        self._session_locks: dict[str, asyncio.Lock] = {}
        self._retiring_instances: dict[str, int] = {}
        self._client_lock = asyncio.Lock()
        self._closed = False

    @staticmethod
    def _default_client_factory(context: ssl.SSLContext) -> httpx.AsyncClient:
        return httpx.AsyncClient(verify=context, follow_redirects=False)

    async def close(self) -> None:
        async with self._client_lock:
            if self._closed:
                return
            self._closed = True
            pooled = [(client, self._session_locks.pop(key)) for key, client in self._clients.items()]
            self._clients.clear()
        await self._close_pooled_clients(pooled)

    async def discard_instance(self, instance_id: str) -> None:
        """Close pooled clients whose cookies and connections belong to one instance."""

        prefix = f"{instance_id}\0"
        async with self._client_lock:
            self._retiring_instances[instance_id] = self._retiring_instances.get(instance_id, 0) + 1
            pooled = [
                (self._clients.pop(key), self._session_locks.pop(key))
                for key in tuple(self._clients)
                if key.startswith(prefix)
            ]
        try:
            await self._close_pooled_clients(pooled)
        finally:
            async with self._client_lock:
                remaining = self._retiring_instances[instance_id] - 1
                if remaining:
                    self._retiring_instances[instance_id] = remaining
                else:
                    del self._retiring_instances[instance_id]

    @staticmethod
    async def _close_pooled_clients(
        pooled: list[tuple[httpx.AsyncClient, asyncio.Lock]],
    ) -> None:
        async def close_when_idle(client: httpx.AsyncClient, session_lock: asyncio.Lock) -> None:
            async with session_lock:
                await client.aclose()

        await asyncio.gather(
            *(close_when_idle(client, session_lock) for client, session_lock in pooled),
            return_exceptions=True,
        )

    async def test_connection(self, instance: JenkinsInstance, token: str) -> dict[str, object]:
        response = await self._request(
            instance,
            token,
            "GET",
            "/api/json",
            params={"tree": "nodeName"},
        )
        return {
            "ok": True,
            "version": response.headers.get("X-Jenkins"),
            "url": instance.base_url,
        }

    async def list_jobs(
        self,
        instance: JenkinsInstance,
        token: str,
        *,
        folder: str = "",
        query: str | None = None,
    ) -> list[dict[str, object]]:
        endpoint = f"{_job_path(folder)}/api/json" if folder else "/api/json"
        response = await self._request(
            instance,
            token,
            "GET",
            endpoint,
            params={
                "tree": (
                    "jobs[name,fullName,url,color,_class,buildable,inQueue,"
                    "lastBuild[number,url,displayName,fullDisplayName,building,result,timestamp,"
                    "duration,estimatedDuration,queueId,description]]"
                )
            },
        )
        payload = self._json_object(response)
        jobs = payload.get("jobs")
        if not isinstance(jobs, list):
            return []
        normalized = [self._normalize_job(item, folder=folder) for item in jobs if isinstance(item, dict)]
        if query:
            needle = query.casefold().strip()
            normalized = [
                job
                for job in normalized
                if needle in str(job["name"]).casefold() or needle in str(job["full_name"]).casefold()
            ]
        return normalized

    async def get_job(
        self,
        instance: JenkinsInstance,
        token: str,
        *,
        job: str,
        include_parameter_options: bool = False,
        parameter_values: Mapping[str, str | int | float | bool | list[str]] | None = None,
    ) -> dict[str, object]:
        parameter_fields = "name,type,_class,description,choices,choiceType,sectionHeader"
        if include_parameter_options:
            parameter_fields += ",defaultParameterValue[value],allValueItems[values[name,value],errors]"
        response = await self._request(
            instance,
            token,
            "GET",
            f"{_job_path(job)}/api/json",
            params={
                "tree": (
                    "name,fullName,url,color,_class,buildable,inQueue,description,"
                    f"actions[_class,parameterDefinitions[{parameter_fields}]],"
                    f"property[_class,parameterDefinitions[{parameter_fields}]],"
                    "lastBuild[number,url,displayName,fullDisplayName,building,result,timestamp,duration,"
                    "estimatedDuration,queueId,description]"
                )
            },
        )
        payload = self._json_object(response)
        detail = self._normalize_job(payload, folder=_parent_job(job))
        parameter_sources = (payload.get("property"), payload.get("actions"))
        parameters = self._normalize_parameters(
            *parameter_sources,
            options_requested=include_parameter_options,
        )
        hidden_values: dict[str, str] = {}
        if include_parameter_options:
            form_parameter_names = {
                str(parameter["name"])
                for parameter in parameters
                if (
                    parameter.get("type") == "hidden"
                    or parameter.get("_form_dynamic") is True
                    or (
                        parameter.get("_form_options") is True
                        and parameter.get("options_state") != "ready"
                    )
                )
            }
            if form_parameter_names:
                form_snapshot = await self._get_build_parameter_snapshot(
                    instance,
                    token,
                    job=job,
                    expected_names=form_parameter_names,
                )
                await self._resolve_form_fill_choices(
                    instance,
                    token,
                    job=job,
                    snapshot=form_snapshot,
                )
                hidden_values = _merge_build_form_parameters(parameters, form_snapshot.parameters)
                _apply_active_choice_bindings(parameters, form_snapshot.active_choices)
                await self._resolve_active_choice_parameters(
                    instance,
                    token,
                    snapshot=form_snapshot,
                    parameters=parameters,
                    parameter_values=parameter_values or {},
                )
        detail["parameters"] = parameters
        detail["_hidden_values"] = hidden_values
        detail["parameterized"] = self._has_parameter_definitions(*parameter_sources)
        detail["requires_explicit_password"] = any(
            parameter.get("_form_dynamic") is True for parameter in parameters
        ) and any(parameter.get("type") == "password" for parameter in parameters)
        detail["description"] = _optional_string(payload.get("description"))
        return detail

    async def list_builds(
        self,
        instance: JenkinsInstance,
        token: str,
        *,
        job: str,
        limit: int,
    ) -> list[dict[str, object]]:
        fields = (
            "number,url,displayName,fullDisplayName,building,result,timestamp,duration,"
            "estimatedDuration,queueId,description"
        )
        response = await self._request(
            instance,
            token,
            "GET",
            f"{_job_path(job)}/api/json",
            params={"tree": f"builds[{fields}]{{0,{limit}}}"},
        )
        payload = self._json_object(response)
        builds = payload.get("builds")
        if not isinstance(builds, list):
            return []
        normalized = [self._normalize_build(item) for item in builds if isinstance(item, dict)]
        return [build for build in normalized if _is_positive_int(build.get("number"))][:limit]

    async def get_build(
        self,
        instance: JenkinsInstance,
        token: str,
        *,
        job: str,
        number: int,
    ) -> dict[str, object]:
        response = await self._request(
            instance,
            token,
            "GET",
            f"{_job_path(job)}/{number}/api/json",
            params={
                "tree": (
                    "number,url,displayName,fullDisplayName,building,result,timestamp,duration,"
                    "estimatedDuration,queueId,description"
                )
            },
        )
        build = self._normalize_build(self._json_object(response))
        if not _is_positive_int(build.get("number")):
            raise JenkinsApiError(502, "Jenkins returned a build without a valid number")
        return build

    async def trigger_build(
        self,
        instance: JenkinsInstance,
        token: str,
        *,
        job: str,
        parameters: Mapping[str, str | int | float | bool | list[str]],
        parameterized: bool,
        classic: bool = False,
    ) -> dict[str, object]:
        if classic:
            endpoint = f"{_job_path(job)}/build"
            request_parameters = [{"name": key, "value": value} for key, value in parameters.items()]
            form_data = {
                "json": json.dumps(
                    {"parameter": request_parameters},
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            }
            # Omit delay so Jenkins applies the job's configured quiet period.
            request_params: Mapping[str, object] | None = None
        else:
            endpoint = f"{_job_path(job)}/buildWithParameters" if parameterized else f"{_job_path(job)}/build"
            form_data = {
                key: [_parameter_value(item) for item in value]
                if isinstance(value, list)
                else _parameter_value(value)
                for key, value in parameters.items()
            }
            request_params = None
        # This state-changing request is deliberately issued exactly once.
        response = await self._request(
            instance,
            token,
            "POST",
            endpoint,
            params=request_params,
            data=form_data or None,
            expected_statuses={200, 201, 202, 302, 303},
        )
        location = response.headers.get("Location", "")
        absolute_location = urljoin(f"{instance.base_url}/", location) if location else ""
        match = _QUEUE_ITEM_PATTERN.search(urlsplit(absolute_location).path)
        return {
            "id": int(match.group("id")) if match else None,
            "url": absolute_location,
            "location": location,
        }

    async def stop_build(
        self,
        instance: JenkinsInstance,
        token: str,
        *,
        job: str,
        number: int,
    ) -> None:
        await self._request(
            instance,
            token,
            "POST",
            f"{_job_path(job)}/{number}/stop",
            expected_statuses={200, 201, 202, 302, 303},
        )

    async def list_queue(self, instance: JenkinsInstance, token: str) -> list[dict[str, object]]:
        response = await self._request(
            instance,
            token,
            "GET",
            "/queue/api/json",
            params={
                "tree": (
                    "items[id,url,blocked,buildable,stuck,why,"
                    "task[name,fullName,url,color],executable[number,url]]"
                )
            },
        )
        payload = self._json_object(response)
        items = payload.get("items")
        if not isinstance(items, list):
            return []
        normalized = [self._normalize_queue_item(item) for item in items if isinstance(item, dict)]
        return [item for item in normalized if _is_positive_int(item.get("id"))]

    async def cancel_queue_item(
        self,
        instance: JenkinsInstance,
        token: str,
        *,
        queue_id: int,
    ) -> None:
        await self._request(
            instance,
            token,
            "POST",
            "/queue/cancelItem",
            params={"id": queue_id},
            expected_statuses={200, 201, 202, 204, 302, 303},
        )

    async def progressive_log(
        self,
        instance: JenkinsInstance,
        token: str,
        *,
        job: str,
        number: int,
        start: int,
    ) -> dict[str, object]:
        endpoint = f"{_job_path(job)}/{number}/logText/progressiveText"
        url = f"{instance.base_url}{endpoint}"
        headers = _request_headers(instance, token)
        content = bytearray()
        truncated = False
        next_offset_header: str | None = None
        more_header = "false"
        encoding: str | None = None
        client, session_lock = await self._acquire_client(instance, token)
        try:
            try:
                async with client.stream(
                    "GET",
                    url,
                    params={"start": start},
                    headers=headers,
                    timeout=instance.request_timeout,
                ) as response:
                    if response.status_code != 200:
                        raise _response_error(response.status_code)
                    next_offset_header = response.headers.get("X-Text-Size")
                    more_header = response.headers.get("X-More-Data", "false")
                    encoding = response.encoding
                    async for chunk in response.aiter_bytes():
                        remaining = _MAX_LOG_CHUNK_BYTES - len(content)
                        if len(chunk) > remaining:
                            content.extend(chunk[:remaining])
                            truncated = True
                            break
                        content.extend(chunk)
            except JenkinsApiError:
                raise
            except httpx.InvalidURL as exc:
                raise JenkinsApiError(400, "Jenkins URL is invalid") from exc
            except httpx.TimeoutException as exc:
                raise JenkinsApiError(504, "Jenkins request timed out") from exc
            except httpx.TransportError as exc:
                detail = (
                    "Jenkins TLS verification failed"
                    if _is_tls_error(exc)
                    else "Unable to connect to Jenkins"
                )
                raise JenkinsApiError(502, detail) from exc
        finally:
            session_lock.release()

        consumed, text = _decode_log_content(bytes(content), encoding, truncated=truncated)
        if truncated:
            next_offset = start + len(consumed)
        else:
            try:
                next_offset = (
                    int(next_offset_header) if next_offset_header is not None else start + len(consumed)
                )
            except ValueError:
                next_offset = start + len(consumed)
        next_offset = max(start, next_offset)
        more = truncated or more_header.casefold() == "true"
        return {
            "offset": start,
            "next_offset": next_offset,
            "text": text,
            "more": more,
            "complete": not more,
        }

    async def _get_build_parameter_form(
        self,
        instance: JenkinsInstance,
        token: str,
        *,
        job: str,
        expected_names: set[str],
    ) -> dict[str, _BuildFormParameter]:
        snapshot = await self._get_build_parameter_snapshot(
            instance,
            token,
            job=job,
            expected_names=expected_names,
        )
        return snapshot.parameters

    async def _get_build_parameter_snapshot(
        self,
        instance: JenkinsInstance,
        token: str,
        *,
        job: str,
        expected_names: set[str],
    ) -> _BuildFormSnapshot:
        """Read a bounded same-job HTML form without following or exposing redirects."""

        if not expected_names:
            return _BuildFormSnapshot({}, {}, "")
        endpoint = f"{_job_path(job)}/build"
        url = f"{instance.base_url}{endpoint}"
        headers = _request_headers(instance, token)
        headers.update(
            {
                "Accept": "text/html,application/xhtml+xml",
                "Referer": f"{instance.base_url}{_job_path(job)}/",
                "User-Agent": "Mozilla/5.0 (compatible; Service-Console/Jenkins)",
            }
        )
        content = bytearray()
        encoding: str | None = None
        status_code = 0
        oversized = False
        form_timeout = min(
            _MAX_BUILD_FORM_TIMEOUT_SECONDS,
            max(_MIN_BUILD_FORM_TIMEOUT_SECONDS, instance.request_timeout),
        )
        client, session_lock = await self._acquire_client(instance, token)
        try:
            try:
                async with client.stream(
                    "GET",
                    url,
                    params={"delay": "0sec"},
                    headers=headers,
                    timeout=form_timeout,
                    follow_redirects=False,
                ) as response:
                    status_code = response.status_code
                    if status_code not in {200, 405}:
                        return _BuildFormSnapshot({}, {}, "")
                    content_length = _optional_int(response.headers.get("Content-Length"))
                    if content_length is not None and content_length > _MAX_BUILD_FORM_BYTES:
                        return _BuildFormSnapshot({}, {}, "")
                    encoding = response.encoding
                    async for chunk in response.aiter_bytes():
                        remaining = _MAX_BUILD_FORM_BYTES - len(content)
                        if len(chunk) > remaining:
                            oversized = True
                            break
                        content.extend(chunk)
            except (httpx.InvalidURL, httpx.TimeoutException, httpx.TransportError):
                return _BuildFormSnapshot({}, {}, "")
        finally:
            session_lock.release()
        if oversized:
            return _BuildFormSnapshot({}, {}, "")

        try:
            html = bytes(content).decode(encoding or "utf-8", errors="replace")
        except LookupError:
            html = bytes(content).decode("utf-8", errors="replace")
        parser = _JenkinsBuildFormParser(expected_names)
        try:
            parser.feed(html)
            parser.close()
        except Exception:  # noqa: BLE001 - malformed remote HTML is an unavailable option source.
            return _BuildFormSnapshot({}, {}, "")
        if not parser.has_valid_parameter_form:
            return _BuildFormSnapshot({}, {}, "")
        script_parser = _JenkinsActiveChoiceScriptParser(expected_names)
        try:
            script_parser.feed(html)
            script_parser.close()
        except Exception:  # noqa: BLE001 - malformed remote scripts are ignored safely.
            script_parser.bindings.clear()
        return _BuildFormSnapshot(
            parameters=parser.parameters,
            active_choices=script_parser.bindings,
            referer=url,
        )

    async def _resolve_form_fill_choices(
        self,
        instance: JenkinsInstance,
        token: str,
        *,
        job: str,
        snapshot: _BuildFormSnapshot,
    ) -> None:
        job_path = _job_path(job)
        descriptor_prefix = f"{job_path}/descriptorByName/"
        for name, form_parameter in tuple(snapshot.parameters.items()):
            fill_url = form_parameter.fill_url
            if not fill_url:
                continue
            parsed = urlsplit(fill_url)
            relative_path = _jenkins_relative_endpoint(instance, parsed.path)
            if (
                parsed.scheme
                or parsed.netloc
                or parsed.fragment
                or not relative_path.startswith(descriptor_prefix)
                or not relative_path.endswith("/fillValueItems")
            ):
                continue
            query_items = parse_qsl(parsed.query, keep_blank_values=True)
            if len(query_items) > 20 or dict(query_items).get("param") != name:
                continue
            try:
                response = await self._request(
                    instance,
                    token,
                    "GET",
                    relative_path,
                    params=dict(query_items),
                )
            except JenkinsApiError:
                continue
            if len(response.content) > _MAX_BUILD_FORM_BYTES:
                continue
            try:
                payload = self._json_object(response)
            except JenkinsApiError:
                continue
            choices = _fill_value_item_choices(payload)
            if not choices:
                continue
            snapshot.parameters[name] = _BuildFormParameter(
                choices=tuple(choices),
                selected=form_parameter.selected,
                multiple=form_parameter.multiple,
                hidden_value=form_parameter.hidden_value,
                has_hidden_value=form_parameter.has_hidden_value,
                has_select=form_parameter.has_select,
                fill_url=form_parameter.fill_url,
            )

    async def _resolve_active_choice_parameters(
        self,
        instance: JenkinsInstance,
        token: str,
        *,
        snapshot: _BuildFormSnapshot,
        parameters: list[dict[str, object]],
        parameter_values: Mapping[str, str | int | float | bool | list[str]],
    ) -> None:
        if not snapshot.active_choices:
            return
        values = _active_choice_reference_values(parameters, snapshot.parameters, parameter_values)
        client, session_lock = await self._acquire_client(instance, token)
        try:
            for parameter in parameters:
                name = str(parameter.get("name") or "")
                binding = snapshot.active_choices.get(name)
                if binding is None:
                    continue
                reference_text = "__LESEP__".join(
                    f"{reference}={_active_choice_reference_value(values.get(reference))}"
                    for reference in binding.references
                )
                resolved = await self._request_active_choice_values(
                    client,
                    instance,
                    token,
                    binding=binding,
                    referer=snapshot.referer,
                    reference_text=reference_text,
                )
                if resolved is None:
                    continue
                choices, selected = resolved
                parameter["choices"] = choices or None
                parameter["options_state"] = "ready" if choices else "unavailable"
                if selected:
                    parameter["default"] = (
                        selected if parameter.get("multiple") is True else selected[0]
                    )
                submitted = parameter_values.get(name, _MISSING)
                if submitted is not _MISSING:
                    values[name] = submitted
                elif selected:
                    values[name] = selected if parameter.get("multiple") is True else selected[0]
                elif choices:
                    values[name] = [] if parameter.get("multiple") is True else choices[0]
        finally:
            session_lock.release()

    async def _request_active_choice_values(
        self,
        client: httpx.AsyncClient,
        instance: JenkinsInstance,
        token: str,
        *,
        binding: _ActiveChoiceBinding,
        referer: str,
        reference_text: str,
    ) -> tuple[list[str], list[str]] | None:
        headers = _request_headers(instance, token)
        headers.update(
            {
                "Accept": "application/json",
                "Content-Type": "application/x-stapler-method-invocation;charset=UTF-8",
                "Crumb": binding.crumb,
                "Referer": referer,
                "User-Agent": "Mozilla/5.0 (compatible; Service-Console/Jenkins)",
            }
        )
        timeout = min(
            _MAX_BUILD_FORM_TIMEOUT_SECONDS,
            max(_MIN_BUILD_FORM_TIMEOUT_SECONDS, instance.request_timeout),
        )
        endpoint = _jenkins_relative_endpoint(instance, binding.endpoint).rstrip("/")
        if re.fullmatch(r"/\$stapler/bound/[0-9A-Za-z-]{1,128}", endpoint) is None:
            return None
        try:
            update = await client.post(
                f"{instance.base_url}{endpoint}/doUpdate",
                content=json.dumps([reference_text], ensure_ascii=False, separators=(",", ":")),
                headers=headers,
                timeout=timeout,
                follow_redirects=False,
            )
            if update.status_code not in {200, 204}:
                return None
            response = await client.post(
                f"{instance.base_url}{endpoint}/getChoicesForUI",
                content="[]",
                headers=headers,
                timeout=timeout,
                follow_redirects=False,
            )
        except (httpx.InvalidURL, httpx.TimeoutException, httpx.TransportError):
            return None
        if response.status_code != 200 or len(response.content) > _MAX_BUILD_FORM_BYTES:
            return None
        try:
            payload = response.json()
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            return None
        return _normalize_active_choice_response(payload, reference_only=binding.reference_only)

    async def _request(
        self,
        instance: JenkinsInstance,
        token: str,
        method: str,
        endpoint: str,
        *,
        params: Mapping[str, object] | None = None,
        data: Mapping[str, str] | None = None,
        expected_statuses: set[int] | None = None,
    ) -> httpx.Response:
        normalized_method = method.upper()
        client, session_lock = await self._acquire_client(instance, token)
        try:
            if normalized_method == "POST":
                # Keep the session cookie from this fresh crumb paired with the one
                # state-changing request. The write itself is still sent exactly once.
                crumb_header = await self._fetch_crumb_header(client, instance, token)
                headers = _request_headers(instance, token)
                if crumb_header is not None:
                    headers[crumb_header[0]] = crumb_header[1]
                return await self._send_request(
                    client,
                    instance,
                    normalized_method,
                    endpoint,
                    params=params,
                    data=data,
                    headers=headers,
                    expected_statuses=expected_statuses,
                    is_write=True,
                    crumb_sent=crumb_header is not None,
                )
            return await self._send_request(
                client,
                instance,
                normalized_method,
                endpoint,
                params=params,
                data=data,
                headers=_request_headers(instance, token),
                expected_statuses=expected_statuses,
            )
        finally:
            session_lock.release()

    async def _send_request(
        self,
        client: httpx.AsyncClient,
        instance: JenkinsInstance,
        method: str,
        endpoint: str,
        *,
        params: Mapping[str, object] | None = None,
        data: Mapping[str, str] | None = None,
        headers: Mapping[str, str],
        expected_statuses: set[int] | None = None,
        is_write: bool = False,
        crumb_sent: bool = False,
    ) -> httpx.Response:
        url = f"{instance.base_url}{endpoint}"
        try:
            response = await client.request(
                method,
                url,
                params=params,
                data=data,
                headers=headers,
                timeout=instance.request_timeout,
            )
        except httpx.InvalidURL as exc:
            raise JenkinsApiError(400, "Jenkins URL is invalid") from exc
        except httpx.TimeoutException as exc:
            raise JenkinsApiError(504, "Jenkins request timed out") from exc
        except httpx.TransportError as exc:
            detail = (
                "Jenkins TLS verification failed" if _is_tls_error(exc) else "Unable to connect to Jenkins"
            )
            raise JenkinsApiError(502, detail) from exc

        allowed = expected_statuses or {200}
        if response.status_code not in allowed:
            raise _response_error(
                response.status_code,
                is_write=is_write,
                crumb_sent=crumb_sent,
                crumb_rejected=_response_rejects_crumb(response),
            )
        return response

    async def _fetch_crumb_header(
        self,
        client: httpx.AsyncClient,
        instance: JenkinsInstance,
        token: str,
    ) -> tuple[str, str] | None:
        response = await self._send_request(
            client,
            instance,
            "GET",
            "/crumbIssuer/api/json",
            headers=_request_headers(instance, token),
            expected_statuses={200, 401, 403, 404},
        )
        if response.status_code != 200:
            # API tokens can be exempt from CSRF protection, and Jenkins may have the
            # crumb issuer disabled or protected separately. Let the one write decide.
            return None

        payload = self._json_object(response)
        field = payload.get("crumbRequestField")
        crumb = payload.get("crumb")
        if (
            not isinstance(field, str)
            or not field
            or len(field) > 256
            or _HTTP_HEADER_NAME_PATTERN.fullmatch(field) is None
            or field.casefold() in _RESERVED_CRUMB_HEADERS
            or not isinstance(crumb, str)
            or not crumb
            or len(crumb) > 4096
            or _CRUMB_VALUE_PATTERN.fullmatch(crumb) is None
        ):
            raise JenkinsApiError(502, "Jenkins returned an invalid CSRF crumb response")
        return field, crumb

    async def _acquire_client(
        self,
        instance: JenkinsInstance,
        token: str,
    ) -> tuple[httpx.AsyncClient, asyncio.Lock]:
        key, client, session_lock = await self._pooled_client_for(instance, token)
        await session_lock.acquire()
        live = False
        try:
            async with self._client_lock:
                if self._closed:
                    raise JenkinsApiError(503, "Jenkins client is shutting down")
                live = self._clients.get(key) is client and self._session_locks.get(key) is session_lock
                if not live:
                    raise JenkinsApiError(409, "Jenkins connection changed before the request")
                return client, session_lock
        finally:
            if not live:
                session_lock.release()

    async def _pooled_client_for(
        self,
        instance: JenkinsInstance,
        token: str,
    ) -> tuple[str, httpx.AsyncClient, asyncio.Lock]:
        ca_key = str(Path(instance.ca_bundle).expanduser().resolve()) if instance.ca_bundle else "<system>"
        credential_fingerprint = hashlib.sha256(f"{instance.username}\0{token}".encode()).hexdigest()
        key = f"{instance.id}\0{instance.base_url}\0{ca_key}\0{credential_fingerprint}"
        async with self._client_lock:
            if self._closed:
                raise JenkinsApiError(503, "Jenkins client is shutting down")
            if self._retiring_instances.get(instance.id, 0):
                raise JenkinsApiError(409, "Jenkins connection is being refreshed")
            client = self._clients.get(key)
            if client is not None:
                return key, client, self._session_locks[key]
            try:
                context = ssl.create_default_context(cafile=ca_key if instance.ca_bundle else None)
            except (OSError, ssl.SSLError) as exc:
                raise JenkinsApiError(400, "Jenkins CA bundle could not be loaded") from exc
            client = self._client_factory(context)
            session_lock = asyncio.Lock()
            self._clients[key] = client
            self._session_locks[key] = session_lock
            return key, client, session_lock

    @staticmethod
    def _json_object(response: httpx.Response) -> dict[str, Any]:
        try:
            payload = response.json()
        except (json.JSONDecodeError, ValueError) as exc:
            raise JenkinsApiError(502, "Jenkins returned an invalid JSON response") from exc
        if not isinstance(payload, dict):
            raise JenkinsApiError(502, "Jenkins returned an unexpected JSON response")
        return payload

    @classmethod
    def _normalize_job(cls, value: Mapping[str, Any], *, folder: str) -> dict[str, object]:
        name = str(value.get("name") or "")
        full_name = str(value.get("fullName") or "/".join(part for part in (folder, name) if part))
        last_build = value.get("lastBuild")
        normalized_last_build = cls._normalize_build(last_build) if isinstance(last_build, dict) else None
        if normalized_last_build is not None and not _is_positive_int(normalized_last_build.get("number")):
            normalized_last_build = None
        return {
            "name": name,
            "full_name": full_name,
            "url": str(value.get("url") or ""),
            "kind": _job_kind(value.get("_class")),
            "color": _optional_string(value.get("color")),
            "status": _job_status(value.get("color")),
            "buildable": bool(value.get("buildable", False)),
            "in_queue": bool(value.get("inQueue", False)),
            "last_build": normalized_last_build,
        }

    @staticmethod
    def _normalize_build(value: Mapping[str, Any]) -> dict[str, object]:
        building = bool(value.get("building", False))
        result = _optional_string(value.get("result"))
        return {
            "number": _optional_int(value.get("number")),
            "url": str(value.get("url") or ""),
            "display_name": str(value.get("displayName") or ""),
            "full_display_name": str(value.get("fullDisplayName") or ""),
            "building": building,
            "result": result,
            "status": "RUNNING" if building else (result or "UNKNOWN"),
            "timestamp": _optional_int(value.get("timestamp")),
            "duration": _optional_int(value.get("duration")),
            "estimated_duration": _optional_int(value.get("estimatedDuration")),
            "queue_id": _optional_int(value.get("queueId")),
            "description": _optional_string(value.get("description")),
        }

    @staticmethod
    def _has_parameter_definitions(*sources: object) -> bool:
        return any(
            isinstance(source, list)
            and any(
                isinstance(item, dict) and isinstance(item.get("parameterDefinitions"), list)
                for item in source
            )
            for source in sources
        )

    @staticmethod
    def _normalize_parameters(
        *sources: object,
        options_requested: bool = False,
    ) -> list[dict[str, object]]:
        result: list[dict[str, object]] = []
        seen_names: set[str] = set()
        for source in sources:
            if not isinstance(source, list):
                continue
            for item in source:
                definitions = item.get("parameterDefinitions") if isinstance(item, dict) else None
                if not isinstance(definitions, list):
                    continue
                for definition in definitions:
                    if not isinstance(definition, dict):
                        continue
                    name = str(definition.get("name") or "").strip()
                    if not name or name in seen_names:
                        continue
                    seen_names.add(name)
                    default_value = definition.get("defaultParameterValue")
                    raw_type = str(
                        definition.get("type") or definition.get("_class") or "StringParameterDefinition"
                    )
                    classification_type = str(definition.get("_class") or raw_type)
                    choice_type = str(definition.get("choiceType") or "")
                    filesystem_list = any(
                        _is_filesystem_list_parameter(candidate)
                        for candidate in (classification_type, raw_type)
                    )
                    parameter_type = _parameter_kind(classification_type)
                    candidate_kinds = {
                        _parameter_kind(candidate)
                        for candidate in (classification_type, raw_type, choice_type)
                    }
                    if "unsupported" in candidate_kinds:
                        parameter_type = "unsupported"
                    elif "reference" in candidate_kinds:
                        parameter_type = "reference"
                    elif "file" in candidate_kinds and not filesystem_list:
                        parameter_type = "file"
                    elif "hidden" in candidate_kinds:
                        parameter_type = "hidden"
                    elif "password" in candidate_kinds:
                        parameter_type = "password"
                    elif "separator" in candidate_kinds:
                        parameter_type = "separator"
                    elif "choice" in candidate_kinds:
                        parameter_type = "choice"
                    form_dynamic = parameter_type == "choice" and (
                        _is_form_dynamic_parameter(classification_type)
                        or _is_form_dynamic_parameter(raw_type)
                        or _is_form_dynamic_parameter(choice_type)
                        or _is_active_choice_parameter(classification_type)
                        or _is_active_choice_parameter(raw_type)
                    )
                    dynamic_choice = (
                        parameter_type == "choice" and form_dynamic
                        or _is_dynamic_choice_parameter(classification_type)
                        or _is_dynamic_choice_parameter(raw_type)
                    )
                    active_choice = any(
                        _is_active_choice_parameter(candidate)
                        for candidate in (classification_type, raw_type)
                    )
                    form_options = parameter_type == "choice" and (
                        form_dynamic or dynamic_choice or active_choice
                    )
                    choices = _parameter_choices(definition)
                    options_state = "not_applicable"
                    if parameter_type == "choice":
                        options_state = (
                            "ready"
                            if choices is not None
                            else ("unavailable" if options_requested else "not_loaded")
                        )
                    default = (
                        default_value.get("value")
                        if isinstance(default_value, dict)
                        and parameter_type not in {"hidden", "password", "separator"}
                        else None
                    )
                    result.append(
                        {
                            "name": name,
                            "type": parameter_type,
                            "raw_type": raw_type,
                            "description": _optional_string(definition.get("description")),
                            "default": default,
                            "choices": choices,
                            "options_state": options_state,
                            "multiple": any(
                                _parameter_is_multiple(candidate)
                                for candidate in (choice_type, raw_type, classification_type)
                            ),
                            "_explicit_single": any(
                                _parameter_is_explicit_single(candidate)
                                for candidate in (choice_type, raw_type, classification_type)
                            ),
                            **(
                                {
                                    "header": str(
                                        definition.get("sectionHeader") or definition.get("description") or ""
                                    )
                                }
                                if parameter_type == "separator"
                                else {}
                            ),
                            "_form_dynamic": form_dynamic,
                            "_form_options": form_options or parameter_type == "reference",
                            "_dynamic_choice": dynamic_choice,
                            "_active_choice": active_choice,
                            "_filesystem_list": filesystem_list,
                            **({"references": []} if active_choice else {}),
                        }
                    )
        return result

    @staticmethod
    def _normalize_queue_item(value: Mapping[str, Any]) -> dict[str, object]:
        task = value.get("task")
        executable = value.get("executable")
        return {
            "id": _optional_int(value.get("id")),
            "url": str(value.get("url") or ""),
            "blocked": bool(value.get("blocked", False)),
            "buildable": bool(value.get("buildable", False)),
            "stuck": bool(value.get("stuck", False)),
            "why": _optional_string(value.get("why")),
            "task": (
                {
                    "name": str(task.get("name") or ""),
                    "full_name": str(task.get("fullName") or task.get("name") or ""),
                    "url": str(task.get("url") or ""),
                    "color": _optional_string(task.get("color")),
                }
                if isinstance(task, dict)
                else None
            ),
            "executable": (
                {"number": _optional_int(executable.get("number")), "url": str(executable.get("url") or "")}
                if isinstance(executable, dict)
                else None
            ),
        }


class JenkinsService:
    """Coordinate persisted instances, credentials, and remote requests."""

    def __init__(
        self,
        data_dir: str | Path,
        *,
        credential_store: CredentialStore | None = None,
        gateway: JenkinsGateway | None = None,
    ) -> None:
        self.store = JenkinsInstanceStore(data_dir)
        self.credentials = credential_store or KeyringCredentialStore()
        self.gateway = gateway or JenkinsGateway()
        self._instances: dict[str, JenkinsInstance] = {}
        self._lock = asyncio.Lock()
        self._initialized = False

    async def initialize(self) -> None:
        async with self._lock:
            if self._initialized:
                return
            self._instances = await asyncio.to_thread(self.store.load)
            self._initialized = True

    async def shutdown(self) -> None:
        await self.gateway.close()

    async def list_instances(self) -> list[dict[str, object]]:
        await self._ensure_initialized()
        async with self._lock:
            instances = sorted(self._instances.values(), key=lambda item: item.name.casefold())
        return [await self._public_instance(instance) for instance in instances]

    async def create_instance(
        self,
        *,
        name: str,
        base_url: str,
        username: str,
        token: str | None,
        ca_bundle: str | None,
        enabled: bool,
        request_timeout: float,
    ) -> dict[str, object]:
        await self._ensure_initialized()
        normalized_token = _normalize_token(token) if token is not None else None
        instance = JenkinsInstance(
            id=str(uuid.uuid4()),
            name=name,
            base_url=base_url,
            username=username,
            ca_bundle=ca_bundle,
            enabled=enabled,
            request_timeout=request_timeout,
        )
        async with self._lock:
            self._ensure_unique_name(instance.name)
            if normalized_token is not None:
                await asyncio.to_thread(self.credentials.set, instance.id, normalized_token)
            updated = {**self._instances, instance.id: instance}
            try:
                await asyncio.to_thread(self.store.save, updated)
            except Exception:
                if normalized_token is not None:
                    await asyncio.to_thread(self.credentials.delete, instance.id)
                raise
            self._instances = updated
        return await self._public_instance(instance)

    async def update_instance(
        self,
        instance_id: str,
        *,
        name: str,
        base_url: str,
        username: str,
        token: str | None,
        ca_bundle: str | None,
        enabled: bool,
        request_timeout: float,
    ) -> dict[str, object]:
        await self._ensure_initialized()
        normalized_token = _normalize_token(token) if token is not None else None
        async with self._lock:
            current = self._require(instance_id)
            replacement = JenkinsInstance(
                id=current.id,
                name=name,
                base_url=base_url,
                username=username,
                ca_bundle=ca_bundle,
                enabled=enabled,
                request_timeout=request_timeout,
            )
            self._ensure_unique_name(replacement.name, excluding=instance_id)
            updated = {**self._instances, instance_id: replacement}
            previous_token: str | None = None
            if normalized_token is not None:
                previous_token = await asyncio.to_thread(self.credentials.get, instance_id)
                await asyncio.to_thread(self.credentials.set, instance_id, normalized_token)
            try:
                await asyncio.to_thread(self.store.save, updated)
            except Exception:
                if normalized_token is not None:
                    if previous_token is None:
                        await asyncio.to_thread(self.credentials.delete, instance_id)
                    else:
                        await asyncio.to_thread(self.credentials.set, instance_id, previous_token)
                raise
            self._instances = updated
        await self.gateway.discard_instance(instance_id)
        return await self._public_instance(replacement)

    async def delete_instance(self, instance_id: str) -> None:
        await self._ensure_initialized()
        async with self._lock:
            current = self._require(instance_id)
            updated = {key: value for key, value in self._instances.items() if key != instance_id}
            await asyncio.to_thread(self.store.save, updated)
            self._instances = updated
            try:
                await asyncio.to_thread(self.credentials.delete, instance_id)
            except Exception:
                restored = {**self._instances, instance_id: current}
                await asyncio.to_thread(self.store.save, restored)
                self._instances = restored
                raise
        await self.gateway.discard_instance(instance_id)

    async def test_connection(self, instance_id: str) -> dict[str, object]:
        instance, token = await self._connection(instance_id, allow_disabled=True)
        return await self.gateway.test_connection(instance, token)

    async def list_jobs(self, instance_id: str, *, folder: str, query: str | None) -> list[dict[str, object]]:
        instance, token = await self._connection(instance_id)
        return await self.gateway.list_jobs(instance, token, folder=folder, query=query)

    async def get_job(
        self,
        instance_id: str,
        *,
        job: str,
        include_parameter_options: bool = False,
        parameter_values: Mapping[str, str | int | float | bool | list[str]] | None = None,
    ) -> dict[str, object]:
        instance, token = await self._connection(instance_id)
        return _public_job_detail(
            await self.gateway.get_job(
                instance,
                token,
                job=job,
                include_parameter_options=include_parameter_options,
                parameter_values=parameter_values,
            )
        )

    async def list_builds(self, instance_id: str, *, job: str, limit: int) -> list[dict[str, object]]:
        instance, token = await self._connection(instance_id)
        return await self.gateway.list_builds(instance, token, job=job, limit=limit)

    async def get_build(self, instance_id: str, *, job: str, number: int) -> dict[str, object]:
        instance, token = await self._connection(instance_id)
        return await self.gateway.get_build(instance, token, job=job, number=number)

    async def trigger_build(
        self,
        instance_id: str,
        *,
        job: str,
        parameters: Mapping[str, str | int | float | bool | list[str]],
    ) -> dict[str, object]:
        instance, token = await self._connection(instance_id)
        job_detail = await self.gateway.get_job(
            instance,
            token,
            job=job,
            include_parameter_options=True,
            parameter_values=parameters,
        )
        definitions_value = job_detail.get("parameters")
        definitions = definitions_value if isinstance(definitions_value, list) else []
        parameterized_value = job_detail.get("parameterized")
        parameterized = parameterized_value if isinstance(parameterized_value, bool) else bool(definitions)
        if any(
            isinstance(definition, dict) and definition.get("type") == "file" for definition in definitions
        ):
            raise JenkinsApiError(400, "Jenkins file parameters are not supported")
        if any(
            isinstance(definition, dict) and definition.get("type") == "unsupported"
            for definition in definitions
        ):
            raise JenkinsApiError(400, "Jenkins parameter type is not supported")
        if not parameterized and parameters:
            raise JenkinsApiError(400, "Jenkins job is not parameterized")
        definition_names = {
            str(definition.get("name") or "")
            for definition in definitions
            if isinstance(definition, dict) and definition.get("name")
        }
        unknown_names = sorted(set(parameters) - definition_names)
        if unknown_names:
            raise JenkinsApiError(
                400,
                f"Jenkins parameter {unknown_names[0]} is not defined for this job",
            )

        dynamic_definitions = [
            definition
            for definition in definitions
            if isinstance(definition, dict) and definition.get("_dynamic_choice") is True
        ]
        form_dynamic_definitions = [
            definition for definition in dynamic_definitions if definition.get("_form_dynamic") is True
        ]
        for definition in dynamic_definitions:
            if definition.get("options_state") != "ready":
                raise JenkinsApiError(400, "Jenkins dynamic parameter options are unavailable")

        password_names = {
            str(definition.get("name"))
            for definition in definitions
            if isinstance(definition, dict) and definition.get("type") == "password"
        }
        separator_names = {
            str(definition.get("name"))
            for definition in definitions
            if isinstance(definition, dict) and definition.get("type") == "separator"
        }
        reference_names = {
            str(definition.get("name"))
            for definition in definitions
            if isinstance(definition, dict) and definition.get("type") == "reference"
        }
        hidden_names = {
            str(definition.get("name"))
            for definition in definitions
            if isinstance(definition, dict) and definition.get("type") == "hidden"
        }
        submitted_parameters: dict[str, str | int | float | bool | list[str]] = {
            name: value
            for name, value in parameters.items()
            if name not in separator_names
            and name not in reference_names
            and name not in hidden_names
            and not (name in password_names and value == "")
        }
        definitions_by_name = {
            str(definition.get("name")): definition
            for definition in definitions
            if isinstance(definition, dict) and definition.get("name")
        }
        for name, value in submitted_parameters.items():
            multiple = definitions_by_name[name].get("multiple") is True
            if multiple:
                if not isinstance(value, list):
                    raise JenkinsApiError(400, f"Jenkins multi-select parameter {name} must be a list")
                if len(value) > _MAX_MULTI_SELECT_VALUES:
                    raise JenkinsApiError(400, f"Jenkins multi-select parameter {name} has too many values")
                if any(not isinstance(item, str) for item in value):
                    raise JenkinsApiError(400, f"Jenkins multi-select parameter {name} must contain strings")
                submitted_parameters[name] = list(dict.fromkeys(value))
            elif isinstance(value, list):
                raise JenkinsApiError(400, f"Jenkins parameter {name} does not accept multiple values")

        for definition in dynamic_definitions:
            name = str(definition.get("name") or "")
            choices_value = definition.get("choices")
            choices = choices_value if isinstance(choices_value, list) else []
            choice_values = [choice for choice in choices if isinstance(choice, str)]
            if name in submitted_parameters:
                submitted_value = submitted_parameters[name]
                if definition.get("multiple") is True:
                    selected_values = submitted_value if isinstance(submitted_value, list) else []
                    if any(value not in choice_values for value in selected_values):
                        raise JenkinsApiError(
                            400,
                            f"Jenkins parameter {name} contains a value that is not a current choice",
                        )
                    submitted_parameters[name] = selected_values
                else:
                    if isinstance(submitted_value, list):
                        raise JenkinsApiError(400, f"Jenkins parameter {name} does not accept multiple values")
                    normalized_value = _parameter_value(submitted_value)
                    if normalized_value not in choice_values:
                        raise JenkinsApiError(
                            400,
                            f"Jenkins parameter {name} is not one of the current choices",
                        )
                    submitted_parameters[name] = normalized_value
            elif choice_values and definition.get("_form_dynamic") is True:
                default = definition.get("default")
                if definition.get("multiple") is True:
                    default_values = default if isinstance(default, list) else []
                    submitted_parameters[name] = [
                        value for value in default_values if isinstance(value, str) and value in choice_values
                    ]
                else:
                    submitted_parameters[name] = (
                        default if isinstance(default, str) and default in choice_values else choice_values[0]
                    )

        if form_dynamic_definitions:
            for definition in definitions:
                if not isinstance(definition, dict):
                    continue
                name = str(definition.get("name") or "")
                parameter_type = definition.get("type")
                if parameter_type == "password" and name not in submitted_parameters:
                    raise JenkinsApiError(
                        400,
                        f"Jenkins password parameter {name} must be provided for dynamic builds",
                    )
                if not name or name in submitted_parameters or parameter_type in {"hidden", "separator"}:
                    continue
                default = definition.get("default")
                if isinstance(default, list) and definition.get("multiple") is True:
                    submitted_parameters[name] = [value for value in default if isinstance(value, str)]
                elif isinstance(default, str | int | float | bool):
                    submitted_parameters[name] = default

        hidden_values_value = job_detail.get("_hidden_values")
        hidden_values = hidden_values_value if isinstance(hidden_values_value, dict) else {}
        if hidden_names and any(name not in hidden_values for name in hidden_names):
            raise JenkinsApiError(502, "Jenkins hidden parameter defaults are unavailable")
        for name in hidden_names:
            value = hidden_values.get(name)
            if isinstance(value, str):
                submitted_parameters[name] = value

        return await self.gateway.trigger_build(
            instance,
            token,
            job=job,
            parameters=submitted_parameters,
            parameterized=parameterized,
            classic=bool(form_dynamic_definitions),
        )

    async def stop_build(self, instance_id: str, *, job: str, number: int) -> None:
        instance, token = await self._connection(instance_id)
        await self.gateway.stop_build(instance, token, job=job, number=number)

    async def list_queue(self, instance_id: str) -> list[dict[str, object]]:
        instance, token = await self._connection(instance_id)
        return await self.gateway.list_queue(instance, token)

    async def cancel_queue_item(self, instance_id: str, *, queue_id: int) -> None:
        instance, token = await self._connection(instance_id)
        await self.gateway.cancel_queue_item(instance, token, queue_id=queue_id)

    async def progressive_log(
        self,
        instance_id: str,
        *,
        job: str,
        number: int,
        start: int,
    ) -> dict[str, object]:
        instance, token = await self._connection(instance_id)
        return await self.gateway.progressive_log(instance, token, job=job, number=number, start=start)

    async def _connection(
        self,
        instance_id: str,
        *,
        allow_disabled: bool = False,
    ) -> tuple[JenkinsInstance, str]:
        await self._ensure_initialized()
        async with self._lock:
            instance = self._require(instance_id)
        if not instance.enabled and not allow_disabled:
            raise JenkinsApiError(409, "Jenkins instance is disabled")
        token = await asyncio.to_thread(self.credentials.get, instance.id)
        if token is None:
            raise JenkinsApiError(409, "Jenkins API token is unavailable; update the instance token")
        return instance, token

    async def _public_instance(self, instance: JenkinsInstance) -> dict[str, object]:
        credential_error: str | None = None
        try:
            token_present = await asyncio.to_thread(self.credentials.get, instance.id) is not None
        except JenkinsApiError as exc:
            token_present = False
            credential_error = exc.detail
        return {
            **instance.to_dict(),
            "token_present": token_present,
            "credential_error": credential_error,
        }

    async def _ensure_initialized(self) -> None:
        if not self._initialized:
            await self.initialize()

    def _require(self, instance_id: str) -> JenkinsInstance:
        try:
            return self._instances[instance_id]
        except KeyError:
            raise KeyError(f"Jenkins instance not found: {instance_id}") from None

    def _ensure_unique_name(self, name: str, *, excluding: str | None = None) -> None:
        normalized = name.casefold()
        for instance_id, instance in self._instances.items():
            if instance_id != excluding and instance.name.casefold() == normalized:
                raise ValueError(f"Jenkins instance name already exists: {name}")


def _job_segments(value: str) -> list[str]:
    normalized = str(value).strip().strip("/")
    if not normalized:
        raise ValueError("Jenkins job path is required")
    segments = normalized.split("/")
    if any(
        not segment or segment in {".", ".."} or _CONTROL_CHARACTER_PATTERN.search(segment)
        for segment in segments
    ):
        raise ValueError("Jenkins job path is invalid")
    return segments


def _job_path(value: str) -> str:
    return "".join(f"/job/{quote(segment, safe='')}" for segment in _job_segments(value))


def _parent_job(value: str) -> str:
    segments = _job_segments(value)
    return "/".join(segments[:-1])


def _job_kind(value: object) -> str:
    class_name = str(value or "").casefold()
    if "folder" in class_name or "multibranch" in class_name or "organizationfolder" in class_name:
        return "folder"
    if "workflowjob" in class_name:
        return "pipeline"
    if "freestyle" in class_name:
        return "freestyle"
    return "job"


def _job_status(value: object) -> str:
    color = str(value or "").casefold()
    if color.endswith("_anime"):
        return "RUNNING"
    return {
        "blue": "SUCCESS",
        "green": "SUCCESS",
        "red": "FAILURE",
        "yellow": "UNSTABLE",
        "aborted": "ABORTED",
        "disabled": "DISABLED",
        "notbuilt": "NOT_BUILT",
        "grey": "UNKNOWN",
        "gray": "UNKNOWN",
    }.get(color, "UNKNOWN")


def _parameter_kind(value: str) -> str:
    class_name = value.casefold()
    simple_name = class_name.rsplit(".", 1)[-1]
    if simple_name == "dynamicreferenceparameter":
        return "reference"
    if simple_name in {"cascadechoiceparameter", "pt_radio"}:
        return "choice"
    if _is_form_dynamic_parameter(value) or "gitparameter" in class_name:
        return "choice"
    if simple_name.endswith("fileparameterdefinition"):
        return "file"
    if simple_name in {"hiddenparameterdefinition", "whideparameterdefinition"}:
        return "hidden"
    if simple_name == "parameterseparatordefinition":
        return "separator"
    if "boolean" in class_name:
        return "boolean"
    if "choice" in class_name:
        return "choice"
    if "password" in class_name:
        return "password"
    if "text" in class_name:
        return "text"
    if "integer" in class_name or "number" in class_name:
        return "number"
    if "credential" in class_name:
        return "credentials"
    if "run" in class_name:
        return "run"
    return "string"


def _is_form_dynamic_parameter(value: str) -> bool:
    class_name = value.casefold()
    simple_name = class_name.rsplit(".", 1)[-1]
    return (
        simple_name == "filesystemlistparameterdefinition"
        or simple_name
        in {
            "pt_checkbox",
            "pt_multi_select",
            "pt_radio",
            "pt_single_select",
        }
        or simple_name
        in {
            "choiceparameter",
        }
    )


def _is_filesystem_list_parameter(value: str) -> bool:
    return value.casefold().rsplit(".", 1)[-1] == "filesystemlistparameterdefinition"


def _is_active_choice_parameter(value: str) -> bool:
    return value.casefold().rsplit(".", 1)[-1] in {
        "cascadechoiceparameter",
        "dynamicreferenceparameter",
    }


def _is_dynamic_choice_parameter(value: str) -> bool:
    return _is_form_dynamic_parameter(value) or "gitparameter" in value.casefold()


def _parameter_is_multiple(value: str) -> bool:
    simple_name = value.casefold().rsplit(".", 1)[-1]
    return simple_name in {"pt_checkbox", "pt_multi_select"}


def _parameter_is_explicit_single(value: str) -> bool:
    return value.casefold().rsplit(".", 1)[-1] in {"pt_radio", "pt_single_select"}


def _merge_build_form_parameters(
    parameters: list[dict[str, object]],
    form_parameters: Mapping[str, _BuildFormParameter],
) -> dict[str, str]:
    hidden_values: dict[str, str] = {}
    for parameter in parameters:
        name = str(parameter.get("name") or "")
        form_parameter = form_parameters.get(name)
        if parameter.get("type") == "hidden":
            if form_parameter is not None and form_parameter.has_hidden_value:
                hidden_values[name] = form_parameter.hidden_value or ""
            continue
        if parameter.get("_form_options") is not True or parameter.get("type") == "reference":
            continue
        choices = list(form_parameter.choices or ()) if form_parameter is not None else []
        if parameter.get("_filesystem_list") is True and len(choices) == 1:
            # Upstream renders localized filesystem diagnostics as ordinary singleton options,
            # and its exported default may fall back to that same diagnostic. Only an explicit
            # selected marker proves the configured default matched a real rendered candidate.
            selected = set(form_parameter.selected) if form_parameter is not None else set()
            if choices[0] not in selected:
                choices = []
        parameter["choices"] = choices or None
        parameter["multiple"] = False if parameter.get("_explicit_single") is True else (
            bool(parameter.get("multiple")) or bool(form_parameter and form_parameter.multiple)
        )
        parameter["options_state"] = "ready" if choices else "unavailable"
        if form_parameter is not None and form_parameter.selected:
            parameter["default"] = (
                list(form_parameter.selected)
                if parameter["multiple"] is True
                else form_parameter.selected[0]
            )
    return hidden_values


def _apply_active_choice_bindings(
    parameters: list[dict[str, object]],
    bindings: Mapping[str, _ActiveChoiceBinding],
) -> None:
    for parameter in parameters:
        binding = bindings.get(str(parameter.get("name") or ""))
        if binding is None:
            continue
        parameter["references"] = list(binding.references)


def _active_choice_reference_values(
    parameters: list[dict[str, object]],
    form_parameters: Mapping[str, _BuildFormParameter],
    submitted: Mapping[str, str | int | float | bool | list[str]],
) -> dict[str, object]:
    values: dict[str, object] = {}
    for parameter in parameters:
        name = str(parameter.get("name") or "")
        if name in submitted:
            values[name] = submitted[name]
            continue
        form_parameter = form_parameters.get(name)
        if form_parameter is not None and form_parameter.selected:
            values[name] = (
                list(form_parameter.selected)
                if parameter.get("multiple") is True
                else form_parameter.selected[0]
            )
            continue
        default = parameter.get("default")
        if isinstance(default, str | int | float | bool | list):
            values[name] = default
    return values


def _active_choice_reference_value(value: object) -> str:
    if isinstance(value, list):
        candidates = [item for item in value if isinstance(item, str)]
        return ",".join(candidates)
    if isinstance(value, bool):
        return "true" if value else ""
    if isinstance(value, str | int | float):
        return _parameter_value(value)
    return ""


def _normalize_active_choice_response(
    payload: object,
    *,
    reference_only: bool,
) -> tuple[list[str], list[str]] | None:
    if not isinstance(payload, list) or len(payload) < 2:
        return None
    raw_labels, raw_values = payload[0], payload[1]
    if not isinstance(raw_labels, list) or not isinstance(raw_values, list):
        return None
    if len(raw_labels) > _MAX_BUILD_FORM_OPTIONS or len(raw_values) > _MAX_BUILD_FORM_OPTIONS:
        return None
    choices: list[str] = []
    selected: list[str] = []
    for index, raw_label in enumerate(raw_labels):
        raw_value = raw_values[index] if index < len(raw_values) else raw_label
        label, label_selected, label_disabled = _normalize_active_choice_entry(raw_label)
        value, value_selected, value_disabled = _normalize_active_choice_entry(raw_value)
        choice = label if reference_only else value
        if (
            label_disabled
            or value_disabled
            or not choice
            or len(choice) > _MAX_PARAMETER_VALUE_LENGTH
            or choice in choices
        ):
            continue
        choices.append(choice)
        if label_selected or value_selected:
            selected.append(choice)
    return choices, selected


def _normalize_active_choice_entry(value: object) -> tuple[str, bool, bool]:
    if isinstance(value, str):
        normalized = value
    elif isinstance(value, str | int | float | bool):
        normalized = str(value)
    else:
        try:
            normalized = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            return "", False, False
    selected = False
    disabled = False
    suffix_found = True
    while suffix_found:
        suffix_found = False
        if normalized.endswith(":selected"):
            normalized = normalized[: -len(":selected")]
            selected = True
            suffix_found = True
        if normalized.endswith(":disabled"):
            normalized = normalized[: -len(":disabled")]
            disabled = True
            suffix_found = True
    return normalized, selected, disabled


def _public_job_detail(value: Mapping[str, object]) -> dict[str, object]:
    detail = {key: item for key, item in value.items() if not key.startswith("_")}
    raw_parameters = value.get("parameters")
    public_parameters: list[dict[str, object]] = []
    if isinstance(raw_parameters, list):
        for parameter in raw_parameters:
            if not isinstance(parameter, dict) or parameter.get("type") == "hidden":
                continue
            public_parameters.append(
                {key: item for key, item in parameter.items() if not key.startswith("_")}
            )
    detail["parameters"] = public_parameters
    return detail


def _parameter_choices(definition: Mapping[str, Any]) -> list[str] | None:
    value_items = definition.get("allValueItems")
    if isinstance(value_items, dict):
        errors = value_items.get("errors")
        if errors:
            return None

    raw_choices = definition.get("choices")
    if isinstance(raw_choices, list):
        candidates = raw_choices
    else:
        values = value_items.get("values") if isinstance(value_items, dict) else None
        candidates = (
            [item.get("value") for item in values if isinstance(item, dict)]
            if isinstance(values, list)
            else []
        )

    choices: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not isinstance(candidate, str) or candidate in seen:
            continue
        seen.add(candidate)
        choices.append(candidate)
    return choices or None


def _fill_value_item_choices(payload: Mapping[str, Any]) -> list[str] | None:
    if payload.get("errors"):
        return None
    values = payload.get("values")
    if not isinstance(values, list) or len(values) > _MAX_BUILD_FORM_OPTIONS:
        return None
    choices: list[str] = []
    seen: set[str] = set()
    for item in values:
        candidate = item.get("value") if isinstance(item, dict) else None
        if (
            not isinstance(candidate, str)
            or len(candidate) > _MAX_PARAMETER_VALUE_LENGTH
            or candidate in seen
        ):
            continue
        seen.add(candidate)
        choices.append(candidate)
    return choices or None


def _response_error(
    status_code: int,
    *,
    is_write: bool = False,
    crumb_sent: bool = False,
    crumb_rejected: bool = False,
) -> JenkinsApiError:
    if is_write and status_code == 401:
        return JenkinsApiError(403, "Jenkins authentication failed")
    if is_write and status_code in {400, 403} and crumb_rejected:
        if crumb_sent:
            return JenkinsApiError(403, "Jenkins rejected the CSRF crumb")
        return JenkinsApiError(403, "Jenkins requires a CSRF crumb, but no crumb was available")
    if is_write and status_code == 403:
        return JenkinsApiError(403, "Jenkins write permission denied")
    if status_code in {401, 403}:
        return JenkinsApiError(403, "Jenkins authentication or permission denied")
    if status_code == 404:
        return JenkinsApiError(404, "Jenkins resource not found")
    if status_code in {400, 405, 409, 422}:
        return JenkinsApiError(400, "Jenkins rejected the request")
    return JenkinsApiError(502, f"Jenkins returned HTTP {status_code}")


def _response_rejects_crumb(response: httpx.Response) -> bool:
    if response.status_code not in {400, 403}:
        return False
    detail = response.content[:8192].decode("utf-8", errors="ignore").casefold()
    return "crumb" in detail and any(
        marker in detail for marker in ("csrf", "invalid", "missing", "no valid", "not included", "required")
    )


def _is_tls_error(exc: BaseException) -> bool:
    current: BaseException | None = exc
    while current is not None:
        if isinstance(current, ssl.SSLError):
            return True
        current = current.__cause__ or current.__context__
    return "certificate" in str(exc).casefold() or "ssl" in str(exc).casefold()


def _decode_log_content(
    content: bytes,
    encoding: str | None,
    *,
    truncated: bool,
) -> tuple[bytes, str]:
    bounded = content
    selected_encoding = encoding or "utf-8"
    try:
        return bounded, bounded.decode(selected_encoding)
    except LookupError:
        selected_encoding = "utf-8"
    except UnicodeDecodeError as exc:
        if truncated and exc.end == len(bounded):
            bounded = bounded[: exc.start]
            try:
                return bounded, bounded.decode(selected_encoding)
            except UnicodeDecodeError:
                pass
    return bounded, bounded.decode(selected_encoding, errors="replace")


def _request_headers(instance: JenkinsInstance, token: str) -> dict[str, str]:
    authorization = base64.b64encode(f"{instance.username}:{token}".encode()).decode("ascii")
    return {
        "Accept": "application/json",
        "Authorization": f"Basic {authorization}",
        "User-Agent": "Service-Console/Jenkins",
    }


def _parameter_value(value: str | int | float | bool) -> str:  # noqa: PYI041
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Jenkins build parameter values must be finite")
    return str(value)


def _optional_string(value: object) -> str | None:
    return str(value) if value is not None else None


def _optional_int(value: object) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _is_positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0
