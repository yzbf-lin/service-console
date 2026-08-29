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
from pathlib import Path
from threading import RLock
from typing import Any, Protocol
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

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
            pooled = [
                (client, self._session_locks.pop(key)) for key, client in self._clients.items()
            ]
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
    ) -> dict[str, object]:
        response = await self._request(
            instance,
            token,
            "GET",
            f"{_job_path(job)}/api/json",
            params={
                "tree": (
                    "name,fullName,url,color,_class,buildable,inQueue,description,"
                    "actions[_class,parameterDefinitions["
                    "name,type,_class,description,defaultParameterValue[value],choices]],"
                    "property[_class,parameterDefinitions["
                    "name,type,_class,description,defaultParameterValue[value],choices]],"
                    "lastBuild[number,url,displayName,fullDisplayName,building,result,timestamp,duration,"
                    "estimatedDuration,queueId,description]"
                )
            },
        )
        payload = self._json_object(response)
        detail = self._normalize_job(payload, folder=_parent_job(job))
        parameter_sources = (payload.get("property"), payload.get("actions"))
        detail["parameters"] = self._normalize_parameters(*parameter_sources)
        detail["parameterized"] = self._has_parameter_definitions(*parameter_sources)
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
        parameters: Mapping[str, str | int | float | bool],
        parameterized: bool,
    ) -> dict[str, object]:
        endpoint = f"{_job_path(job)}/buildWithParameters" if parameterized else f"{_job_path(job)}/build"
        form_data = {key: _parameter_value(value) for key, value in parameters.items()}
        # This state-changing request is deliberately issued exactly once.
        response = await self._request(
            instance,
            token,
            "POST",
            endpoint,
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
                live = (
                    self._clients.get(key) is client
                    and self._session_locks.get(key) is session_lock
                )
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
    def _normalize_parameters(*sources: object) -> list[dict[str, object]]:
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
                        definition.get("type")
                        or definition.get("_class")
                        or "StringParameterDefinition"
                    )
                    parameter_type = _parameter_kind(raw_type)
                    result.append(
                        {
                            "name": name,
                            "type": parameter_type,
                            "raw_type": raw_type,
                            "description": _optional_string(definition.get("description")),
                            "default": (
                                default_value.get("value")
                                if isinstance(default_value, dict) and parameter_type != "password"
                                else None
                            ),
                            "choices": (
                                definition.get("choices")
                                if isinstance(definition.get("choices"), list)
                                else None
                            ),
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

    async def get_job(self, instance_id: str, *, job: str) -> dict[str, object]:
        instance, token = await self._connection(instance_id)
        return await self.gateway.get_job(instance, token, job=job)

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
        parameters: Mapping[str, str | int | float | bool],
    ) -> dict[str, object]:
        instance, token = await self._connection(instance_id)
        job_detail = await self.gateway.get_job(instance, token, job=job)
        definitions_value = job_detail.get("parameters")
        definitions = definitions_value if isinstance(definitions_value, list) else []
        parameterized_value = job_detail.get("parameterized")
        parameterized = parameterized_value if isinstance(parameterized_value, bool) else bool(definitions)
        if any(
            isinstance(definition, dict) and definition.get("type") == "file" for definition in definitions
        ):
            raise JenkinsApiError(400, "Jenkins file parameters are not supported")
        if not parameterized and parameters:
            raise JenkinsApiError(400, "Jenkins job is not parameterized")

        password_names = {
            str(definition.get("name"))
            for definition in definitions
            if isinstance(definition, dict) and definition.get("type") == "password"
        }
        submitted_parameters = {
            name: value for name, value in parameters.items() if not (name in password_names and value == "")
        }
        return await self.gateway.trigger_build(
            instance,
            token,
            job=job,
            parameters=submitted_parameters,
            parameterized=parameterized,
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
    if "file" in class_name:
        return "file"
    if "credential" in class_name:
        return "credentials"
    if "run" in class_name:
        return "run"
    return "string"


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
        marker in detail
        for marker in ("csrf", "invalid", "missing", "no valid", "not included", "required")
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
