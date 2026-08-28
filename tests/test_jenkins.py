from __future__ import annotations

import base64
import json
import ssl
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient

from service_console.api import create_app
from service_console.jenkins import (
    JenkinsApiError,
    JenkinsGateway,
    JenkinsInstance,
    JenkinsService,
    KeyringCredentialStore,
)
from service_console.manager import ServiceManager


class FakeCredentialStore:
    def __init__(self) -> None:
        self.tokens: dict[str, str] = {}
        self.deleted: list[str] = []

    def get(self, instance_id: str) -> str | None:
        return self.tokens.get(instance_id)

    def set(self, instance_id: str, token: str) -> None:
        self.tokens[instance_id] = token

    def delete(self, instance_id: str) -> None:
        self.deleted.append(instance_id)
        self.tokens.pop(instance_id, None)


class FailingDeleteCredentialStore(FakeCredentialStore):
    def delete(self, instance_id: str) -> None:
        raise RuntimeError("keyring locked")


class ChunkStream(httpx.AsyncByteStream):
    def __init__(self, *, chunk: bytes, count: int) -> None:
        self.chunk = chunk
        self.count = count
        self.yielded = 0
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for _ in range(self.count):
            self.yielded += 1
            yield self.chunk

    async def aclose(self) -> None:
        self.closed = True


def instance(**overrides: object) -> JenkinsInstance:
    values: dict[str, object] = {
        "id": "instance-1",
        "name": "Test Jenkins",
        "base_url": "https://ci.example/jenkins",
        "username": "developer",
        "ca_bundle": None,
        "enabled": True,
        "request_timeout": 15,
    }
    values.update(overrides)
    return JenkinsInstance(**values)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_multiple_instances_are_stable_and_credentials_never_touch_json(tmp_path: Path) -> None:
    credentials = FakeCredentialStore()
    service = JenkinsService(tmp_path, credential_store=credentials)

    first = await service.create_instance(
        name="Development",
        base_url="https://ci.example/jenkins/",
        username="dev-user",
        token="dev-secret-token",
        ca_bundle=None,
        enabled=True,
        request_timeout=10,
    )
    second = await service.create_instance(
        name="Production",
        base_url="https://ci.example/jenkins",
        username="prod-user",
        token="prod-secret-token",
        ca_bundle=None,
        enabled=True,
        request_timeout=20,
    )

    assert first["id"] != second["id"]
    assert first["base_url"] == second["base_url"] == "https://ci.example/jenkins"
    assert first["token_present"] is True
    assert "token" not in first

    persisted = (tmp_path / "jenkins-instances.json").read_text(encoding="utf-8")
    assert "dev-secret-token" not in persisted
    assert "prod-secret-token" not in persisted
    assert '"token"' not in persisted

    await service.shutdown()
    restored_service = JenkinsService(tmp_path, credential_store=credentials)
    restored = await restored_service.list_instances()
    assert {item["id"] for item in restored} == {first["id"], second["id"]}
    assert all(item["token_present"] is True for item in restored)

    updated = await restored_service.update_instance(
        str(first["id"]),
        name="Development CI",
        base_url="https://ci.example/jenkins",
        username="dev-user",
        token=None,
        ca_bundle=None,
        enabled=True,
        request_timeout=12,
    )
    assert updated["token_present"] is True
    assert credentials.get(str(first["id"])) == "dev-secret-token"
    await restored_service.shutdown()


@pytest.mark.asyncio
async def test_invalid_update_token_does_not_change_persisted_metadata(tmp_path: Path) -> None:
    credentials = FakeCredentialStore()
    service = JenkinsService(tmp_path, credential_store=credentials)
    created = await service.create_instance(
        name="Original",
        base_url="https://ci.example",
        username="developer",
        token="secret-token",
        ca_bundle=None,
        enabled=True,
        request_timeout=15,
    )
    before = (tmp_path / "jenkins-instances.json").read_text(encoding="utf-8")

    with pytest.raises(ValueError, match="token"):
        await service.update_instance(
            str(created["id"]),
            name="Changed",
            base_url="https://ci.example",
            username="developer",
            token="\n",
            ca_bundle=None,
            enabled=True,
            request_timeout=15,
        )

    assert (tmp_path / "jenkins-instances.json").read_text(encoding="utf-8") == before
    assert (await service.list_instances())[0]["name"] == "Original"
    await service.shutdown()


@pytest.mark.asyncio
async def test_failed_delete_save_keeps_instance_and_credential(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    credentials = FakeCredentialStore()
    service = JenkinsService(tmp_path, credential_store=credentials)
    created = await service.create_instance(
        name="Jenkins",
        base_url="https://ci.example",
        username="developer",
        token="secret-token",
        ca_bundle=None,
        enabled=True,
        request_timeout=15,
    )
    instance_id = str(created["id"])

    def failed_save(_instances: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(service.store, "save", failed_save)
    with pytest.raises(OSError, match="disk full"):
        await service.delete_instance(instance_id)

    assert credentials.get(instance_id) == "secret-token"
    assert (await service.list_instances())[0]["id"] == instance_id
    await service.shutdown()


@pytest.mark.asyncio
async def test_failed_credential_delete_rolls_back_instance_metadata(tmp_path: Path) -> None:
    credentials = FailingDeleteCredentialStore()
    service = JenkinsService(tmp_path, credential_store=credentials)
    created = await service.create_instance(
        name="Jenkins",
        base_url="https://ci.example",
        username="developer",
        token="secret-token",
        ca_bundle=None,
        enabled=True,
        request_timeout=15,
    )

    with pytest.raises(RuntimeError, match="keyring locked"):
        await service.delete_instance(str(created["id"]))

    persisted = json.loads((tmp_path / "jenkins-instances.json").read_text(encoding="utf-8"))
    assert persisted["instances"][0]["id"] == created["id"]
    assert (await service.list_instances())[0]["id"] == created["id"]
    await service.shutdown()


def test_keyring_unavailable_falls_back_to_current_session_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(KeyringCredentialStore, "_secure_backend", staticmethod(lambda: None))
    current_session = KeyringCredentialStore()
    current_session.set("instance-1", "session-token")
    assert current_session.get("instance-1") == "session-token"

    next_session = KeyringCredentialStore()
    assert next_session.get("instance-1") is None


def test_available_keyring_write_failure_is_explicit_and_does_not_use_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BrokenBackend:
        def get_password(self, _service: str, _account: str) -> str:
            return "old-token"

        def set_password(self, _service: str, _account: str, _token: str) -> None:
            raise RuntimeError("backend locked")

        def delete_password(self, _service: str, _account: str) -> None:
            raise AssertionError("not called")

    backend = BrokenBackend()
    monkeypatch.setattr(
        KeyringCredentialStore,
        "_secure_backend",
        staticmethod(lambda: backend),
    )
    store = KeyringCredentialStore()

    with pytest.raises(JenkinsApiError, match="could not save"):
        store.set("instance-1", "new-token")
    assert store.get("instance-1") == "old-token"


@pytest.mark.parametrize(
    "url",
    [
        "https://ci.example:99999",
        "https://bad host.example",
        "https://[invalid",
        "https://user:secret@ci.example",
        "https://ci.example?token=secret",
    ],
)
def test_instance_rejects_ambiguous_or_credential_bearing_urls(url: str) -> None:
    with pytest.raises(ValueError, match="Jenkins base URL"):
        instance(base_url=url)


def test_instance_keeps_compatible_internal_http_url_support() -> None:
    configured = instance(base_url="http://jenkins.internal:8080/")
    assert configured.base_url == "http://jenkins.internal:8080"


@pytest.mark.asyncio
async def test_gateway_encodes_each_folder_segment_and_normalizes_multibranch() -> None:
    observed_urls: list[str] = []
    contexts: list[ssl.SSLContext] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed_urls.append(str(request.url))
        return httpx.Response(
            200,
            json={
                "jobs": [
                    {
                        "name": "mobile",
                        "fullName": "Team A/release#1/mobile",
                        "url": "https://ci.example/job/mobile/",
                        "_class": "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject",
                    }
                ]
            },
        )

    transport = httpx.MockTransport(handler)

    def client_factory(context: ssl.SSLContext) -> httpx.AsyncClient:
        contexts.append(context)
        return httpx.AsyncClient(transport=transport, follow_redirects=False)

    gateway = JenkinsGateway(client_factory)
    jobs = await gateway.list_jobs(
        instance(),
        "secret-token",
        folder="Team A/release#1",
    )

    assert "/jenkins/job/Team%20A/job/release%231/api/json" in observed_urls[0]
    assert jobs[0]["kind"] == "folder"
    assert contexts[0].verify_mode == ssl.CERT_REQUIRED
    assert contexts[0].check_hostname is True
    await gateway.close()


@pytest.mark.asyncio
async def test_gateway_isolates_cookie_jars_for_same_host_different_instances() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            assert "Cookie" not in request.headers
            return httpx.Response(
                200,
                json={"nodeName": "first"},
                headers={"Set-Cookie": "JSESSIONID=first-user; Path=/"},
            )
        assert "Cookie" not in request.headers
        return httpx.Response(200, json={"nodeName": "second"})

    transport = httpx.MockTransport(handler)
    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=transport, follow_redirects=False))
    await gateway.test_connection(
        instance(id="first", username="first-user"),
        "first-token",
    )
    await gateway.test_connection(
        instance(id="second", username="second-user"),
        "second-token",
    )
    await gateway.test_connection(
        instance(id="first", base_url="https://ci.example/other", username="first-user"),
        "first-token",
    )

    assert calls == 3
    await gateway.close()


@pytest.mark.asyncio
async def test_gateway_reports_invalid_custom_ca_without_network(tmp_path: Path) -> None:
    gateway = JenkinsGateway()
    with pytest.raises(JenkinsApiError) as captured:
        await gateway.test_connection(
            instance(ca_bundle=str(tmp_path / "missing.pem")),
            "secret-token",
        )
    assert captured.value.status_code == 400
    assert captured.value.detail == "Jenkins CA bundle could not be loaded"
    await gateway.close()


@pytest.mark.asyncio
async def test_progressive_log_response_is_bounded_without_skipping_offsets() -> None:
    stream = ChunkStream(chunk=b"x" * (1024 * 1024), count=10)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            stream=stream,
            headers={"X-Text-Size": str(10 * 1024 * 1024), "X-More-Data": "false"},
        )

    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    log = await gateway.progressive_log(
        instance(),
        "secret-token",
        job="api",
        number=1,
        start=10,
    )

    assert len(str(log["text"]).encode()) == 2 * 1024 * 1024
    assert log["next_offset"] == 10 + (2 * 1024 * 1024)
    assert log["more"] is True
    assert log["complete"] is False
    assert stream.yielded == 3
    assert stream.closed is True
    await gateway.close()


def test_jenkins_api_contract_covers_jobs_builds_queue_actions_and_logs(tmp_path: Path) -> None:
    credentials = FakeCredentialStore()
    observed: list[httpx.Request] = []
    created_clients: list[httpx.AsyncClient] = []

    def handler(request: httpx.Request) -> httpx.Response:
        observed.append(request)
        auth = request.headers.get("Authorization", "")
        decoded_auth = base64.b64decode(auth.removeprefix("Basic ")).decode()
        username, _, token = decoded_auth.partition(":")
        assert token == "super-secret-token"
        if username == "denied-user":
            return httpx.Response(403, text="super-secret-token must never escape")

        path = request.url.path
        tree = request.url.params.get("tree", "")
        if request.method == "GET" and path == "/jenkins/api/json":
            return httpx.Response(200, json={"nodeName": "built-in"}, headers={"X-Jenkins": "2.479.1"})
        if request.method == "GET" and path == "/jenkins/job/Team A/job/release#1/api/json":
            if "parameterDefinitions" in tree:
                return httpx.Response(
                    200,
                    json={
                        "name": "release#1",
                        "fullName": "Team A/release#1",
                        "url": "https://ci.example/jenkins/job/Team%20A/job/release%231/",
                        "color": "blue",
                        "_class": "org.jenkinsci.plugins.workflow.job.WorkflowJob",
                        "buildable": True,
                        "inQueue": False,
                        "description": "Release pipeline",
                        "actions": [
                            {
                                "parameterDefinitions": [
                                    {
                                        "name": "ENV",
                                        "type": "ChoiceParameterDefinition",
                                        "description": "Target",
                                        "defaultParameterValue": {"value": "staging"},
                                        "choices": ["staging", "production"],
                                    },
                                    {
                                        "name": "PASSWORD",
                                        "type": "PasswordParameterDefinition",
                                        "description": "Secret",
                                        "defaultParameterValue": {"value": "must-not-leak"},
                                    },
                                ]
                            }
                        ],
                        "lastBuild": _raw_build(42, building=False, result="SUCCESS"),
                    },
                )
            if tree.startswith("builds["):
                return httpx.Response(
                    200,
                    json={"builds": [_raw_build(42, building=False, result="SUCCESS")]},
                )
            return httpx.Response(
                200,
                json={
                    "jobs": [
                        {
                            "name": "deploy",
                            "fullName": "Team A/release#1/deploy",
                            "url": "https://ci.example/jenkins/job/deploy/",
                            "color": "blue_anime",
                            "_class": "org.jenkinsci.plugins.workflow.job.WorkflowJob",
                            "buildable": True,
                            "inQueue": True,
                            "lastBuild": _raw_build(7, building=True, result=None),
                        }
                    ]
                },
            )
        if request.method == "GET" and path == "/jenkins/job/Team A/job/release#1/42/api/json":
            return httpx.Response(200, json=_raw_build(42, building=False, result="SUCCESS"))
        if request.method == "POST" and path.endswith("/buildWithParameters"):
            assert parse_qs(request.content.decode()) == {"ENV": ["production"], "DRY_RUN": ["true"]}
            return httpx.Response(201, headers={"Location": "/jenkins/queue/item/91/"})
        if request.method == "POST" and path.endswith("/42/stop"):
            return httpx.Response(302, headers={"Location": "../../42/"})
        if request.method == "GET" and path == "/jenkins/queue/api/json":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": 91,
                            "url": "https://ci.example/jenkins/queue/item/91/",
                            "blocked": False,
                            "buildable": True,
                            "stuck": False,
                            "why": "Waiting for next available executor",
                            "task": {
                                "name": "release#1",
                                "fullName": "Team A/release#1",
                                "url": "https://ci.example/jenkins/job/release%231/",
                                "color": "blue",
                            },
                            "executable": None,
                        }
                    ]
                },
            )
        if request.method == "POST" and path == "/jenkins/queue/cancelItem":
            assert request.url.params["id"] == "91"
            return httpx.Response(204)
        if request.method == "GET" and path.endswith("/42/logText/progressiveText"):
            assert request.url.params["start"] == "10"
            return httpx.Response(
                200,
                text="next line\n",
                headers={"X-Text-Size": "20", "X-More-Data": "true"},
            )
        raise AssertionError(f"unexpected Jenkins request: {request.method} {request.url}")

    transport = httpx.MockTransport(handler)

    def client_factory(_context: ssl.SSLContext) -> httpx.AsyncClient:
        client = httpx.AsyncClient(transport=transport, follow_redirects=False)
        created_clients.append(client)
        return client

    gateway = JenkinsGateway(client_factory)
    jenkins = JenkinsService(tmp_path / "jenkins", credential_store=credentials, gateway=gateway)
    app = create_app(
        data_dir=tmp_path / "app",
        manager=ServiceManager(tmp_path / "services"),
        jenkins_service=jenkins,
    )

    with TestClient(app) as client:
        created = client.post(
            "/api/jenkins/instances",
            json={
                "name": "Primary",
                "base_url": "https://ci.example/jenkins/",
                "username": "developer",
                "token": "super-secret-token",
                "request_timeout": 12,
            },
        )
        assert created.status_code == 201
        created_payload = created.json()["instance"]
        instance_id = created_payload["id"]
        assert created_payload["token_present"] is True
        assert "token" not in created_payload
        assert "super-secret-token" not in created.text

        connection = client.post(f"/api/jenkins/instances/{instance_id}/test")
        assert connection.json() == {
            "connection": {"ok": True, "version": "2.479.1", "url": "https://ci.example/jenkins"}
        }

        jobs = client.get(
            f"/api/jenkins/instances/{instance_id}/jobs",
            params={"folder": "Team A/release#1", "query": "deploy"},
        ).json()
        assert jobs["folder"] == "Team A/release#1"
        assert jobs["jobs"][0]["status"] == "RUNNING"
        assert jobs["jobs"][0]["last_build"]["number"] == 7

        job = client.get(
            f"/api/jenkins/instances/{instance_id}/job",
            params={"job": "Team A/release#1"},
        ).json()["job"]
        assert job["kind"] == "pipeline"
        assert job["parameters"][0] == {
            "name": "ENV",
            "type": "choice",
            "raw_type": "ChoiceParameterDefinition",
            "description": "Target",
            "default": "staging",
            "choices": ["staging", "production"],
        }
        assert job["parameters"][1]["type"] == "password"
        assert job["parameters"][1]["default"] is None
        assert "must-not-leak" not in json.dumps(job)

        builds = client.get(
            f"/api/jenkins/instances/{instance_id}/builds",
            params={"job": "Team A/release#1", "limit": 10},
        ).json()
        assert builds["job"] == "Team A/release#1"
        assert builds["builds"][0]["status"] == "SUCCESS"

        build = client.get(
            f"/api/jenkins/instances/{instance_id}/builds/42",
            params={"job": "Team A/release#1"},
        ).json()["build"]
        assert build["number"] == 42
        assert build["queue_id"] == 142

        triggered = client.post(
            f"/api/jenkins/instances/{instance_id}/builds",
            params={"job": "Team A/release#1"},
            json={"parameters": {"ENV": "production", "DRY_RUN": True}},
        )
        assert triggered.status_code == 202
        assert triggered.json()["queue"] == {
            "id": 91,
            "url": "https://ci.example/jenkins/queue/item/91/",
            "location": "/jenkins/queue/item/91/",
        }

        stopped = client.post(
            f"/api/jenkins/instances/{instance_id}/builds/42/stop",
            params={"job": "Team A/release#1"},
        )
        assert stopped.json() == {"build": {"job": "Team A/release#1", "number": 42, "stopped": True}}

        queue = client.get(f"/api/jenkins/instances/{instance_id}/queue").json()["queue"]
        assert queue[0]["task"]["full_name"] == "Team A/release#1"
        assert queue[0]["executable"] is None

        cancelled = client.post(f"/api/jenkins/instances/{instance_id}/queue/91/cancel")
        assert cancelled.json() == {"queue": {"id": 91, "cancelled": True}}

        log = client.get(
            f"/api/jenkins/instances/{instance_id}/builds/42/log",
            params={"job": "Team A/release#1", "start": 10},
        ).json()["log"]
        assert log == {
            "job": "Team A/release#1",
            "number": 42,
            "offset": 10,
            "next_offset": 20,
            "text": "next line\n",
            "more": True,
            "complete": False,
        }

        denied = client.post(
            "/api/jenkins/instances",
            json={
                "name": "Denied",
                "base_url": "https://ci.example/jenkins",
                "username": "denied-user",
                "token": "super-secret-token",
            },
        ).json()["instance"]
        denied_response = client.get(f"/api/jenkins/instances/{denied['id']}/queue")
        assert denied_response.status_code == 403
        assert denied_response.json() == {"detail": "Jenkins authentication or permission denied"}
        assert "super-secret-token" not in denied_response.text

        listed = client.get("/api/jenkins/instances").json()["instances"]
        assert {item["username"] for item in listed} == {"developer", "denied-user"}
        assert all("token" not in item for item in listed)

    assert created_clients and all(client.is_closed for client in created_clients)
    assert all("super-secret-token" not in str(request.url) for request in observed)


def test_build_trigger_failure_is_not_retried_and_error_is_redacted(tmp_path: Path) -> None:
    credentials = FakeCredentialStore()
    trigger_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal trigger_calls
        if request.method == "GET" and request.url.path == "/job/api/api/json":
            return httpx.Response(
                200,
                json={
                    "name": "api",
                    "fullName": "api",
                    "actions": [],
                },
            )
        if request.method == "POST" and request.url.path.endswith("/build"):
            trigger_calls += 1
            return httpx.Response(503, text="secret-token internal failure")
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    transport = httpx.MockTransport(handler)
    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=transport, follow_redirects=False))
    jenkins = JenkinsService(tmp_path / "jenkins", credential_store=credentials, gateway=gateway)
    app = create_app(
        data_dir=tmp_path / "app",
        manager=ServiceManager(tmp_path / "services"),
        jenkins_service=jenkins,
    )

    with TestClient(app) as client:
        instance_id = client.post(
            "/api/jenkins/instances",
            json={
                "name": "Primary",
                "base_url": "https://ci.example",
                "username": "developer",
                "token": "secret-token",
            },
        ).json()["instance"]["id"]
        response = client.post(
            f"/api/jenkins/instances/{instance_id}/builds",
            params={"job": "api"},
            json={"parameters": {}},
        )

    assert response.status_code == 502
    assert response.json() == {"detail": "Jenkins returned HTTP 503"}
    assert "secret-token" not in response.text
    assert trigger_calls == 1


@pytest.mark.asyncio
async def test_parameterized_build_uses_parameter_endpoint_and_omits_blank_password(
    tmp_path: Path,
) -> None:
    credentials = FakeCredentialStore()
    submitted_forms: list[dict[str, list[str]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/job/api/api/json":
            return httpx.Response(
                200,
                json={
                    "name": "api",
                    "fullName": "api",
                    "actions": [
                        {
                            "parameterDefinitions": [
                                {"name": "ENV", "type": "StringParameterDefinition"},
                                {
                                    "name": "PASSWORD",
                                    "type": "PasswordParameterDefinition",
                                },
                            ]
                        }
                    ],
                },
            )
        if request.method == "POST" and request.url.path == "/job/api/buildWithParameters":
            submitted_forms.append(parse_qs(request.content.decode()))
            return httpx.Response(201, headers={"Location": "/queue/item/7/"})
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    service = JenkinsService(tmp_path, credential_store=credentials, gateway=gateway)
    created = await service.create_instance(
        name="Jenkins",
        base_url="https://ci.example",
        username="developer",
        token="secret-token",
        ca_bundle=None,
        enabled=True,
        request_timeout=15,
    )

    await service.trigger_build(str(created["id"]), job="api", parameters={})
    await service.trigger_build(
        str(created["id"]),
        job="api",
        parameters={"ENV": "production", "PASSWORD": ""},
    )

    assert submitted_forms == [{}, {"ENV": ["production"]}]
    await service.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("definitions", "parameters", "message"),
    [
        ([], {"ENV": "production"}, "not parameterized"),
        (
            [{"name": "ARCHIVE", "type": "FileParameterDefinition"}],
            {},
            "file parameters are not supported",
        ),
    ],
)
async def test_unsupported_build_parameters_are_rejected_without_triggering(
    tmp_path: Path,
    definitions: list[dict[str, str]],
    parameters: dict[str, str],
    message: str,
) -> None:
    credentials = FakeCredentialStore()
    post_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal post_calls
        if request.method == "GET" and request.url.path == "/job/api/api/json":
            return httpx.Response(
                200,
                json={
                    "name": "api",
                    "fullName": "api",
                    "actions": [{"parameterDefinitions": definitions}] if definitions else [],
                },
            )
        if request.method == "POST":
            post_calls += 1
            return httpx.Response(201, headers={"Location": "/queue/item/7/"})
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    service = JenkinsService(tmp_path, credential_store=credentials, gateway=gateway)
    created = await service.create_instance(
        name="Jenkins",
        base_url="https://ci.example",
        username="developer",
        token="secret-token",
        ca_bundle=None,
        enabled=True,
        request_timeout=15,
    )

    with pytest.raises(JenkinsApiError, match=message) as captured:
        await service.trigger_build(str(created["id"]), job="api", parameters=parameters)

    assert captured.value.status_code == 400
    assert post_calls == 0
    await service.shutdown()


@pytest.mark.asyncio
async def test_invalid_build_and_queue_identifiers_are_filtered_or_rejected() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        tree = request.url.params.get("tree", "")
        if path == "/job/api/api/json" and tree.startswith("builds["):
            return httpx.Response(
                200,
                json={
                    "builds": [
                        {"displayName": "missing"},
                        {"number": 0},
                        {"number": -1},
                        {"number": "3", "result": "SUCCESS"},
                    ]
                },
            )
        if path == "/job/api/api/json":
            return httpx.Response(
                200,
                json={
                    "name": "api",
                    "fullName": "api",
                    "actions": [],
                    "lastBuild": {"number": 0},
                },
            )
        if path == "/job/api/7/api/json":
            return httpx.Response(200, json={"displayName": "missing number"})
        if path == "/queue/api/json":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {"why": "missing"},
                        {"id": 0},
                        {"id": -1},
                        {"id": "2", "why": "valid"},
                    ]
                },
            )
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    selected = instance(base_url="https://ci.example")

    builds = await gateway.list_builds(selected, "secret-token", job="api", limit=10)
    queue = await gateway.list_queue(selected, "secret-token")
    job = await gateway.get_job(selected, "secret-token", job="api")
    with pytest.raises(JenkinsApiError, match="valid number") as captured:
        await gateway.get_build(selected, "secret-token", job="api", number=7)

    assert [build["number"] for build in builds] == [3]
    assert [item["id"] for item in queue] == [2]
    assert job["last_build"] is None
    assert captured.value.status_code == 502
    await gateway.close()


def test_missing_token_and_request_validation_are_explicit(tmp_path: Path) -> None:
    app = create_app(
        data_dir=tmp_path / "app",
        manager=ServiceManager(tmp_path / "services"),
        jenkins_credential_store=FakeCredentialStore(),
    )
    with TestClient(app) as client:
        created = client.post(
            "/api/jenkins/instances",
            json={
                "name": "No Token",
                "base_url": "https://ci.example",
                "username": "developer",
            },
        ).json()["instance"]
        assert created["token_present"] is False

        missing = client.get(f"/api/jenkins/instances/{created['id']}/queue")
        assert missing.status_code == 409
        assert missing.json() == {"detail": "Jenkins API token is unavailable; update the instance token"}
        assert (
            client.get(
                f"/api/jenkins/instances/{created['id']}/builds",
                params={"job": "api", "limit": 101},
            ).status_code
            == 422
        )
        assert (
            client.get(
                f"/api/jenkins/instances/{created['id']}/builds/0/log",
                params={"job": "api"},
            ).status_code
            == 422
        )
        sensitive_parameter = "password-value-" + ("x" * 16_384)
        invalid_parameter = client.post(
            f"/api/jenkins/instances/{created['id']}/builds",
            params={"job": "api"},
            json={"parameters": {"PASSWORD": sensitive_parameter}},
        )
        assert invalid_parameter.status_code == 422
        assert "password-value" not in invalid_parameter.text

        sensitive_token = "token-value-" + ("y" * 4_096)
        invalid_token = client.put(
            f"/api/jenkins/instances/{created['id']}",
            json={
                "name": "No Token",
                "base_url": "https://ci.example",
                "username": "developer",
                "token": sensitive_token,
            },
        )
        assert invalid_token.status_code == 422
        assert "token-value" not in invalid_token.text


def _raw_build(number: int, *, building: bool, result: str | None) -> dict[str, Any]:
    return {
        "number": number,
        "url": f"https://ci.example/jenkins/job/release/{number}/",
        "displayName": f"#{number}",
        "fullDisplayName": f"release #{number}",
        "building": building,
        "result": result,
        "timestamp": 1_700_000_000_000,
        "duration": 12_000,
        "estimatedDuration": 15_000,
        "queueId": number + 100,
        "description": None,
    }
