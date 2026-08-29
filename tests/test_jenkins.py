from __future__ import annotations

import asyncio
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
    _JenkinsBuildFormParser,
    _merge_build_form_parameters,
    _parameter_kind,
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


class PausedStream(httpx.AsyncByteStream):
    def __init__(
        self,
        *,
        content: bytes,
        started: asyncio.Event,
        release: asyncio.Event,
    ) -> None:
        self.content = content
        self.started = started
        self.release = release

    async def __aiter__(self) -> AsyncIterator[bytes]:
        self.started.set()
        await self.release.wait()
        yield self.content

    async def aclose(self) -> None:
        return None


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


def test_build_form_parser_extracts_only_expected_structured_controls() -> None:
    html = """
    <html><body>
      <div name="parameter">
        <input type="hidden" name="name" value="IGNORED">
        <select name="value"><option value="leak">leak</option></select>
      </div>
      <form method="post" name="parameters" action="build">
        <div name="parameter">
          <input type="hidden" name="name" value="ARTIFACT">
          <select name="value" multiple>
            <option value="a.zip" selected>A</option>
            <option value="a.zip">duplicate</option>
            <option disabled value="disabled.zip">disabled</option>
            <option>b.zip</option>
          </select>
        </div>
        <div name="parameter">
          <input type="hidden" name="name" value="INTERNAL_TOKEN">
          <input type="hidden" name="value" value="server-only">
        </div>
        <div name="parameter">
          <input type="hidden" name="name" value="UNEXPECTED">
          <select name="value"><option value="ignored">ignored</option></select>
        </div>
      </form>
    </body></html>
    """
    parser = _JenkinsBuildFormParser({"ARTIFACT", "INTERNAL_TOKEN", "IGNORED"})
    parser.feed(html)
    parser.close()

    assert set(parser.parameters) == {"ARTIFACT", "INTERNAL_TOKEN"}
    artifact = parser.parameters["ARTIFACT"]
    assert artifact.choices == ("a.zip", "b.zip")
    assert artifact.selected == ("a.zip",)
    assert artifact.multiple is True
    hidden = parser.parameters["INTERNAL_TOKEN"]
    assert hidden.has_hidden_value is True
    assert hidden.hidden_value == "server-only"
    assert hidden.choices is None


@pytest.mark.parametrize("mode", ["unclosed", "too-many-options", "too-long-option-text"])
def test_build_form_parser_rejects_incomplete_or_excessive_candidate_sets(mode: str) -> None:
    if mode == "unclosed":
        html = """
        <form method="post" name="parameters" action="build">
          <div name="parameter">
            <input type="hidden" name="name" value="ARTIFACT">
            <select name="value"><option value="partial.zip">partial.zip
        """
    elif mode == "too-many-options":
        options = "".join(f'<option value="artifact-{index}.zip">item</option>' for index in range(5_001))
        html = f"""
        <form method="post" name="parameters" action="build">
          <div name="parameter">
            <input type="hidden" name="name" value="ARTIFACT">
            <select name="value">{options}</select>
          </div>
        </form>
        """
    else:
        option_text = "x" * 16_385
        html = f"""
        <form method="post" name="parameters" action="build">
          <div name="parameter">
            <input type="hidden" name="name" value="ARTIFACT">
            <select name="value"><option>{option_text}</option></select>
          </div>
        </form>
        """

    parser = _JenkinsBuildFormParser({"ARTIFACT"})
    parser.feed(html)
    parser.close()

    assert parser.has_valid_parameter_form is False


@pytest.mark.parametrize(
    ("raw_type", "expected"),
    [
        ("alex.jenkins.plugins.FileSystemListParameterDefinition", "choice"),
        ("org.biouno.unochoice.ChoiceParameter", "choice"),
        ("org.biouno.unochoice.CascadeChoiceParameter", "unsupported"),
        ("org.biouno.unochoice.DynamicReferenceParameter", "unsupported"),
        ("PT_RADIO", "unsupported"),
        ("PT_SINGLE_SELECT", "choice"),
        ("PT_MULTI_SELECT", "choice"),
        ("PT_CHECKBOX", "choice"),
        ("com.wangyin.parameter.WHideParameterDefinition", "hidden"),
        ("jenkins.plugins.parameter_separator.ParameterSeparatorDefinition", "separator"),
        ("hudson.model.FileParameterDefinition", "file"),
        ("io.jenkins.plugins.file_parameters.Base64FileParameterDefinition", "file"),
        ("io.jenkins.plugins.file_parameters.StashedFileParameterDefinition", "file"),
    ],
)
def test_parameter_kind_distinguishes_dynamic_visual_and_upload_parameters(
    raw_type: str,
    expected: str,
) -> None:
    assert _parameter_kind(raw_type) == expected


def test_parameter_class_has_priority_for_normalization_without_changing_raw_type() -> None:
    parameters = JenkinsGateway._normalize_parameters(
        [
            {
                "parameterDefinitions": [
                    {
                        "name": "ARTIFACT",
                        "type": "FileParameterDefinition",
                        "_class": "alex.jenkins.plugins.FileSystemListParameterDefinition",
                    }
                ]
            }
        ]
    )

    assert parameters[0]["type"] == "choice"
    assert parameters[0]["raw_type"] == "FileParameterDefinition"
    assert parameters[0]["options_state"] == "not_loaded"


def test_file_parameter_raw_type_overrides_a_generic_exported_class() -> None:
    parameters = JenkinsGateway._normalize_parameters(
        [
            {
                "parameterDefinitions": [
                    {
                        "name": "ARCHIVE",
                        "type": "Base64FileParameterDefinition",
                        "_class": "example.plugins.GenericParameterDefinition",
                    }
                ]
            }
        ]
    )

    assert parameters[0]["type"] == "file"


@pytest.mark.parametrize(
    ("raw_type", "expected_type"),
    [
        ("PasswordParameterDefinition", "password"),
        ("WHideParameterDefinition", "hidden"),
        ("ParameterSeparatorDefinition", "separator"),
    ],
)
def test_sensitive_raw_parameter_types_override_a_generic_exported_class(
    raw_type: str,
    expected_type: str,
) -> None:
    parameters = JenkinsGateway._normalize_parameters(
        [
            {
                "parameterDefinitions": [
                    {
                        "name": "SENSITIVE",
                        "type": raw_type,
                        "_class": "example.plugins.GenericParameterDefinition",
                        "defaultParameterValue": {"value": "must-not-leak"},
                    }
                ]
            }
        ]
    )

    assert parameters[0]["type"] == expected_type
    assert parameters[0]["default"] is None


def test_raw_pt_choice_type_enables_form_options_when_exported_class_is_generic() -> None:
    parameters = JenkinsGateway._normalize_parameters(
        [
            {
                "parameterDefinitions": [
                    {
                        "name": "GROUP",
                        "type": "PT_SINGLE_SELECT",
                        "_class": "example.plugins.GenericParameterDefinition",
                    }
                ]
            }
        ]
    )

    assert parameters[0]["type"] == "choice"
    assert parameters[0]["raw_type"] == "PT_SINGLE_SELECT"
    assert parameters[0]["_form_dynamic"] is True
    assert parameters[0]["_dynamic_choice"] is True


def test_active_choices_radio_is_unsupported_even_when_exported_class_is_generic() -> None:
    parameters = JenkinsGateway._normalize_parameters(
        [
            {
                "parameterDefinitions": [
                    {
                        "name": "REGION",
                        "type": "ChoiceParameter",
                        "_class": "org.biouno.unochoice.ChoiceParameter",
                        "choiceType": "PT_RADIO",
                    }
                ]
            }
        ]
    )

    assert parameters[0]["type"] == "unsupported"
    assert parameters[0]["_form_dynamic"] is False


@pytest.mark.parametrize(
    "errors",
    [
        ["The default value has been returned"],
        "The default value has been returned",
        {"message": "The default value has been returned"},
    ],
    ids=["list", "string", "object"],
)
def test_git_parameter_errors_make_fallback_values_unavailable(errors: object) -> None:
    parameters = JenkinsGateway._normalize_parameters(
        [
            {
                "parameterDefinitions": [
                    {
                        "name": "BRANCH",
                        "_class": ("net.uaznia.lukanus.hudson.plugins.gitparameter.GitParameterDefinition"),
                        "allValueItems": {
                            "values": [{"name": "master", "value": "master"}],
                            "errors": errors,
                        },
                    }
                ]
            }
        ],
        options_requested=True,
    )

    assert parameters[0]["choices"] is None
    assert parameters[0]["options_state"] == "unavailable"


@pytest.mark.parametrize(
    ("selected_attribute", "expected_state"),
    [("", "unavailable"), (" selected", "ready")],
)
def test_filesystem_singleton_requires_an_explicit_selected_default(
    selected_attribute: str,
    expected_state: str,
) -> None:
    parameters = JenkinsGateway._normalize_parameters(
        [
            {
                "parameterDefinitions": [
                    {
                        "name": "ARTIFACT",
                        "type": "FileSystemListParameterDefinition",
                        "_class": "alex.jenkins.plugins.FileSystemListParameterDefinition",
                        # Upstream may export its diagnostic fallback as the default as well.
                        "defaultParameterValue": {"value": "only-entry"},
                    }
                ]
            }
        ],
        options_requested=True,
    )
    parser = _JenkinsBuildFormParser({"ARTIFACT"})
    parser.feed(
        f"""
        <form method="post" name="parameters" action="build">
          <div name="parameter">
            <input type="hidden" name="name" value="ARTIFACT">
            <select name="value">
              <option value="only-entry"{selected_attribute}>only-entry</option>
            </select>
          </div>
        </form>
        """
    )
    parser.close()

    _merge_build_form_parameters(parameters, parser.parameters)

    assert parameters[0]["options_state"] == expected_state
    assert parameters[0]["choices"] == (["only-entry"] if expected_state == "ready" else None)


@pytest.mark.parametrize(
    ("choice_type", "expected_multiple", "expected_default"),
    [
        ("PT_SINGLE_SELECT", False, "one"),
        ("PT_MULTI_SELECT", True, ["one", "two"]),
        ("PT_CHECKBOX", True, ["one", "two"]),
    ],
)
def test_active_choices_select_mode_overrides_build_form_multiple_attribute(
    choice_type: str,
    expected_multiple: bool,
    expected_default: str | list[str],
) -> None:
    parameters = JenkinsGateway._normalize_parameters(
        [
            {
                "parameterDefinitions": [
                    {
                        "name": "GROUP",
                        "type": choice_type,
                        "_class": "org.biouno.unochoice.ChoiceParameter",
                        "choiceType": choice_type,
                    }
                ]
            }
        ],
        options_requested=True,
    )
    parser = _JenkinsBuildFormParser({"GROUP"})
    parser.feed(
        """
        <form method="post" name="parameters" action="build">
          <div name="parameter">
            <input type="hidden" name="name" value="GROUP">
            <select name="value" multiple>
              <option value="one" selected>one</option>
              <option value="two" selected>two</option>
            </select>
          </div>
        </form>
        """
    )
    parser.close()

    _merge_build_form_parameters(parameters, parser.parameters)

    assert parameters[0]["multiple"] is expected_multiple
    assert parameters[0]["default"] == expected_default


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
async def test_concurrent_writes_keep_each_crumb_paired_with_its_session() -> None:
    first_crumb_started = asyncio.Event()
    release_first_crumb = asyncio.Event()
    crumb_calls = 0
    post_calls = {1: 0, 2: 0}

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal crumb_calls
        if request.method == "GET" and request.url.path == "/jenkins/crumbIssuer/api/json":
            crumb_calls += 1
            index = crumb_calls
            payload = json.dumps({"crumbRequestField": "Jenkins-Crumb", "crumb": f"crumb-{index}"}).encode()
            headers = {
                "Content-Type": "application/json",
                "Set-Cookie": f"JSESSIONID=session-{index}; Path=/jenkins; HttpOnly",
            }
            if index == 1:
                return httpx.Response(
                    200,
                    headers=headers,
                    stream=PausedStream(
                        content=payload,
                        started=first_crumb_started,
                        release=release_first_crumb,
                    ),
                )
            return httpx.Response(200, headers=headers, content=payload)

        if request.method == "POST" and request.url.path.endswith("/stop"):
            number = int(request.url.path.split("/")[-2])
            post_calls[number] += 1
            assert request.headers["Jenkins-Crumb"] == f"crumb-{number}"
            assert request.headers["Cookie"] == f"JSESSIONID=session-{number}"
            return httpx.Response(200)
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    selected = instance()
    first = asyncio.create_task(gateway.stop_build(selected, "secret-token", job="api", number=1))
    await asyncio.wait_for(first_crumb_started.wait(), timeout=1)
    second = asyncio.create_task(gateway.stop_build(selected, "secret-token", job="api", number=2))
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    second_crumb_was_blocked = crumb_calls == 1
    release_first_crumb.set()

    await asyncio.gather(first, second)
    assert second_crumb_was_blocked is True
    assert crumb_calls == 2
    assert post_calls == {1: 1, 2: 1}
    await gateway.close()
    assert gateway._session_locks == {}


@pytest.mark.asyncio
async def test_concurrent_get_cannot_replace_session_between_crumb_and_post() -> None:
    crumb_started = asyncio.Event()
    release_crumb = asyncio.Event()
    get_calls = 0
    post_calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal get_calls, post_calls
        if request.method == "GET" and request.url.path == "/jenkins/crumbIssuer/api/json":
            payload = json.dumps({"crumbRequestField": "Jenkins-Crumb", "crumb": "write-crumb"}).encode()
            return httpx.Response(
                200,
                headers={
                    "Content-Type": "application/json",
                    "Set-Cookie": "JSESSIONID=write-session; Path=/jenkins; HttpOnly",
                },
                stream=PausedStream(content=payload, started=crumb_started, release=release_crumb),
            )
        if request.method == "GET" and request.url.path == "/jenkins/api/json":
            get_calls += 1
            return httpx.Response(
                200,
                json={"nodeName": "reader"},
                headers={"Set-Cookie": "JSESSIONID=read-session; Path=/jenkins; HttpOnly"},
            )
        if request.method == "POST" and request.url.path == "/jenkins/job/api/1/stop":
            post_calls += 1
            assert request.headers["Jenkins-Crumb"] == "write-crumb"
            assert request.headers["Cookie"] == "JSESSIONID=write-session"
            return httpx.Response(200)
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    selected = instance()
    write = asyncio.create_task(gateway.stop_build(selected, "secret-token", job="api", number=1))
    await asyncio.wait_for(crumb_started.wait(), timeout=1)
    read = asyncio.create_task(gateway.test_connection(selected, "secret-token"))
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    read_was_blocked = get_calls == 0
    release_crumb.set()

    await asyncio.gather(write, read)
    assert read_was_blocked is True
    assert post_calls == 1
    assert get_calls == 1
    await gateway.close()


@pytest.mark.asyncio
async def test_different_pooled_clients_do_not_share_session_lock() -> None:
    first_crumb_started = asyncio.Event()
    release_first_crumb = asyncio.Event()
    post_hosts: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if request.method == "GET" and request.url.path == "/crumbIssuer/api/json":
            payload = json.dumps({"crumbRequestField": "Jenkins-Crumb", "crumb": f"crumb-{host}"}).encode()
            headers = {
                "Content-Type": "application/json",
                "Set-Cookie": f"JSESSIONID=session-{host}; Path=/; HttpOnly",
            }
            if host == "first.example":
                return httpx.Response(
                    200,
                    headers=headers,
                    stream=PausedStream(
                        content=payload,
                        started=first_crumb_started,
                        release=release_first_crumb,
                    ),
                )
            return httpx.Response(200, headers=headers, content=payload)
        if request.method == "POST" and request.url.path == "/job/api/1/stop":
            post_hosts.append(host)
            assert request.headers["Jenkins-Crumb"] == f"crumb-{host}"
            assert request.headers["Cookie"] == f"JSESSIONID=session-{host}"
            return httpx.Response(200)
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    first = asyncio.create_task(
        gateway.stop_build(
            instance(id="first", base_url="https://first.example"),
            "first-token",
            job="api",
            number=1,
        )
    )
    await asyncio.wait_for(first_crumb_started.wait(), timeout=1)
    second = asyncio.create_task(
        gateway.stop_build(
            instance(id="second", base_url="https://second.example"),
            "second-token",
            job="api",
            number=1,
        )
    )
    try:
        await asyncio.wait_for(asyncio.shield(second), timeout=1)
    finally:
        release_first_crumb.set()
    await first

    assert post_hosts == ["second.example", "first.example"]
    await gateway.close()


@pytest.mark.asyncio
async def test_discard_waits_for_active_session_and_removes_its_lock() -> None:
    post_started = asyncio.Event()
    release_post = asyncio.Event()
    created_clients: list[httpx.AsyncClient] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/jenkins/crumbIssuer/api/json":
            return httpx.Response(
                200,
                json={"crumbRequestField": "Jenkins-Crumb", "crumb": "discard-crumb"},
                headers={"Set-Cookie": "JSESSIONID=discard-session; Path=/jenkins"},
            )
        if request.method == "POST" and request.url.path == "/jenkins/job/api/1/stop":
            assert request.headers["Jenkins-Crumb"] == "discard-crumb"
            assert request.headers["Cookie"] == "JSESSIONID=discard-session"
            return httpx.Response(
                200,
                stream=PausedStream(content=b"", started=post_started, release=release_post),
            )
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    def client_factory(_context: ssl.SSLContext) -> httpx.AsyncClient:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        created_clients.append(client)
        return client

    gateway = JenkinsGateway(client_factory)
    write = asyncio.create_task(gateway.stop_build(instance(), "secret-token", job="api", number=1))
    await asyncio.wait_for(post_started.wait(), timeout=1)
    discard = asyncio.create_task(gateway.discard_instance("instance-1"))
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    discard_waited = not discard.done()
    release_post.set()

    await asyncio.gather(write, discard)
    assert discard_waited is True
    assert created_clients and created_clients[0].is_closed
    assert gateway._session_locks == {}
    assert gateway._retiring_instances == {}
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
    crumb_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal crumb_calls
        observed.append(request)
        auth = request.headers.get("Authorization", "")
        decoded_auth = base64.b64decode(auth.removeprefix("Basic ")).decode()
        username, _, token = decoded_auth.partition(":")
        assert token == "super-secret-token"
        if username == "denied-user":
            return httpx.Response(403, text="super-secret-token must never escape")

        path = request.url.path
        tree = request.url.params.get("tree", "")
        if request.method == "GET" and path == "/jenkins/crumbIssuer/api/json":
            crumb_calls += 1
            return httpx.Response(
                200,
                json={
                    "crumbRequestField": "X-Service-Console-Crumb",
                    "crumb": f"fresh-crumb-{crumb_calls}",
                },
                headers={"Set-Cookie": (f"JSESSIONID=crumb-session-{crumb_calls}; Path=/jenkins; HttpOnly")},
            )
        if request.method == "POST":
            assert request.headers["X-Service-Console-Crumb"] == f"fresh-crumb-{crumb_calls}"
            assert request.headers["Cookie"] == f"JSESSIONID=crumb-session-{crumb_calls}"
        if request.method == "GET" and path == "/jenkins/api/json":
            return httpx.Response(200, json={"nodeName": "built-in"}, headers={"X-Jenkins": "2.479.1"})
        if request.method == "GET" and path == "/jenkins/job/Team A/job/release#1/api/json":
            if "parameterDefinitions" in tree:
                environment_parameter: dict[str, object] = {
                    "name": "ENV",
                    "type": "ChoiceParameterDefinition",
                    "description": "Target",
                    "choices": ["staging", "production"],
                }
                password_parameter: dict[str, object] = {
                    "name": "PASSWORD",
                    "type": "PasswordParameterDefinition",
                    "description": "Secret",
                }
                git_parameter: dict[str, object] = {
                    "name": "BRANCH",
                    "_class": "net.uaznia.lukanus.hudson.plugins.gitparameter.GitParameterDefinition",
                    "description": "Branch",
                }
                dry_run_parameter: dict[str, object] = {
                    "name": "DRY_RUN",
                    "type": "BooleanParameterDefinition",
                    "description": "Validate only",
                }
                if "defaultParameterValue" in tree:
                    environment_parameter["defaultParameterValue"] = {"value": "staging"}
                    password_parameter["defaultParameterValue"] = {"value": "must-not-leak"}
                    git_parameter["defaultParameterValue"] = {"value": "master"}
                    dry_run_parameter["defaultParameterValue"] = {"value": False}
                if "allValueItems" in tree:
                    git_parameter["allValueItems"] = {
                        "values": [
                            {"name": "master", "value": "master"},
                            {"name": "feature/api", "value": "feature/api"},
                            {"name": "duplicate", "value": "master"},
                            {"name": "invalid", "value": None},
                        ],
                        "errors": [],
                    }
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
                                    environment_parameter,
                                    password_parameter,
                                    git_parameter,
                                    dry_run_parameter,
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
            "default": None,
            "choices": ["staging", "production"],
            "options_state": "ready",
            "multiple": False,
        }
        assert job["parameters"][1]["type"] == "password"
        assert job["parameters"][1]["default"] is None
        assert job["parameters"][2] == {
            "name": "BRANCH",
            "type": "choice",
            "raw_type": "net.uaznia.lukanus.hudson.plugins.gitparameter.GitParameterDefinition",
            "description": "Branch",
            "default": None,
            "choices": None,
            "options_state": "not_loaded",
            "multiple": False,
        }
        assert "must-not-leak" not in json.dumps(job)

        job_with_options = client.get(
            f"/api/jenkins/instances/{instance_id}/job",
            params={"job": "Team A/release#1", "include_parameter_options": True},
        ).json()["job"]
        assert job_with_options["parameters"][0]["default"] == "staging"
        assert job_with_options["parameters"][2]["default"] == "master"
        assert job_with_options["parameters"][2]["choices"] == ["master", "feature/api"]

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
    assert crumb_calls == 3
    assert all("super-secret-token" not in str(request.url) for request in observed)
    job_detail_trees = [
        request.url.params.get("tree", "")
        for request in observed
        if request.method == "GET"
        and request.url.path == "/jenkins/job/Team A/job/release#1/api/json"
        and "parameterDefinitions" in request.url.params.get("tree", "")
    ]
    assert len(job_detail_trees) == 3
    assert sum("allValueItems" in tree for tree in job_detail_trees) == 2
    assert sum("defaultParameterValue" in tree for tree in job_detail_trees) == 2


def test_build_trigger_failure_is_not_retried_and_error_is_redacted(tmp_path: Path) -> None:
    credentials = FakeCredentialStore()
    crumb_calls = 0
    trigger_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal crumb_calls, trigger_calls
        if request.method == "GET" and request.url.path == "/job/api/api/json":
            return httpx.Response(
                200,
                json={
                    "name": "api",
                    "fullName": "api",
                    "actions": [],
                },
            )
        if request.method == "GET" and request.url.path == "/crumbIssuer/api/json":
            crumb_calls += 1
            return httpx.Response(
                200,
                json={"crumbRequestField": "Jenkins-Crumb", "crumb": "secret-crumb"},
            )
        if request.method == "POST" and request.url.path.endswith("/build"):
            trigger_calls += 1
            assert request.headers["Jenkins-Crumb"] == "secret-crumb"
            return httpx.Response(503, text="secret-token secret-crumb internal failure")
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
    assert "secret-crumb" not in response.text
    assert crumb_calls == 1
    assert trigger_calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("crumb_status", [401, 403, 404])
async def test_write_continues_once_without_crumb_when_issuer_is_unavailable(
    crumb_status: int,
) -> None:
    crumb_calls = 0
    write_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal crumb_calls, write_calls
        if request.method == "GET" and request.url.path == "/jenkins/crumbIssuer/api/json":
            crumb_calls += 1
            return httpx.Response(crumb_status, text="issuer unavailable secret-token")
        if request.method == "POST" and request.url.path == "/jenkins/job/api/7/stop":
            write_calls += 1
            assert "Jenkins-Crumb" not in request.headers
            return httpx.Response(200)
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    await gateway.stop_build(instance(), "secret-token", job="api", number=7)

    assert crumb_calls == 1
    assert write_calls == 1
    await gateway.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"crumbRequestField": "Authorization", "crumb": "secret-crumb"},
        {"crumbRequestField": "Jenkins-Crumb", "crumb": "secret-crumb\r\nInjected: yes"},
        {"crumbRequestField": "Jenkins-Crumb"},
    ],
)
async def test_invalid_crumb_response_blocks_write_and_redacts_secrets(
    payload: dict[str, object],
) -> None:
    write_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal write_calls
        if request.method == "GET" and request.url.path == "/jenkins/crumbIssuer/api/json":
            return httpx.Response(200, json=payload)
        if request.method == "POST":
            write_calls += 1
            return httpx.Response(200)
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(JenkinsApiError) as captured:
        await gateway.stop_build(instance(), "secret-token", job="api", number=7)

    assert captured.value.status_code == 502
    assert captured.value.detail == "Jenkins returned an invalid CSRF crumb response"
    assert "secret-token" not in str(captured.value)
    assert "secret-crumb" not in str(captured.value)
    assert write_calls == 0
    await gateway.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("crumb_status", "write_detail", "expected_detail"),
    [
        (200, "permission denied secret-token", "Jenkins write permission denied"),
        (200, "No valid crumb was included: secret-crumb", "Jenkins rejected the CSRF crumb"),
        (
            404,
            "No valid crumb was included: secret-token",
            "Jenkins requires a CSRF crumb, but no crumb was available",
        ),
    ],
)
async def test_write_denial_distinguishes_permissions_and_missing_crumb_without_leaks(
    crumb_status: int,
    write_detail: str,
    expected_detail: str,
) -> None:
    write_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal write_calls
        if request.method == "GET" and request.url.path == "/jenkins/crumbIssuer/api/json":
            if crumb_status != 200:
                return httpx.Response(crumb_status)
            return httpx.Response(
                200,
                json={"crumbRequestField": "Jenkins-Crumb", "crumb": "secret-crumb"},
            )
        if request.method == "POST" and request.url.path == "/jenkins/job/api/7/stop":
            write_calls += 1
            return httpx.Response(403, text=write_detail)
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with pytest.raises(JenkinsApiError) as captured:
        await gateway.stop_build(instance(), "secret-token", job="api", number=7)

    assert captured.value.status_code == 403
    assert captured.value.detail == expected_detail
    assert "secret-token" not in str(captured.value)
    assert "secret-crumb" not in str(captured.value)
    assert write_calls == 1
    await gateway.close()


@pytest.mark.asyncio
async def test_parameterized_build_uses_parameter_endpoint_and_omits_blank_password(
    tmp_path: Path,
) -> None:
    credentials = FakeCredentialStore()
    crumb_calls = 0
    submitted_forms: list[dict[str, list[str]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal crumb_calls
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
        if request.method == "GET" and request.url.path == "/crumbIssuer/api/json":
            crumb_calls += 1
            return httpx.Response(
                200,
                json={
                    "crumbRequestField": "Jenkins-Crumb",
                    "crumb": f"parameter-crumb-{crumb_calls}",
                },
            )
        if request.method == "POST" and request.url.path == "/job/api/buildWithParameters":
            assert request.headers["Jenkins-Crumb"] == f"parameter-crumb-{crumb_calls}"
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
    assert crumb_calls == 2
    await service.shutdown()


@pytest.mark.asyncio
async def test_dynamic_form_options_hidden_defaults_and_classic_build_are_server_controlled(
    tmp_path: Path,
) -> None:
    credentials = FakeCredentialStore()
    job_get_calls = 0
    form_get_calls = 0
    crumb_calls = 0
    classic_payloads: list[dict[str, object]] = []

    def definitions(tree: str) -> list[dict[str, object]]:
        values: list[dict[str, object]] = [
            {
                "name": "ARTIFACT",
                "type": "FileSystemListParameterDefinition",
                "_class": "alex.jenkins.plugins.FileSystemListParameterDefinition",
                "description": "Server artifact",
            },
            {
                "name": "DEPLOY_PASSWORD",
                "type": "PasswordParameterDefinition",
                "_class": "hudson.model.PasswordParameterDefinition",
            },
            {
                "name": "INTERNAL_TOKEN",
                "type": "WHideParameterDefinition",
                "_class": "com.wangyin.parameter.WHideParameterDefinition",
            },
            {
                "name": "SECTION",
                "type": "ParameterSeparatorDefinition",
                "_class": "jenkins.plugins.parameter_separator.ParameterSeparatorDefinition",
                "sectionHeader": "Deployment",
            },
            {
                "name": "DRY_RUN",
                "type": "BooleanParameterDefinition",
                "_class": "hudson.model.BooleanParameterDefinition",
            },
        ]
        if "defaultParameterValue" in tree:
            values[0]["defaultParameterValue"] = {"value": "/srv/artifacts/a.zip"}
            values[1]["defaultParameterValue"] = {"value": "password-must-not-leak"}
            values[2]["defaultParameterValue"] = {"value": "api-must-not-leak"}
            values[4]["defaultParameterValue"] = {"value": False}
        return values

    build_form = """
    <html><body><form method="post" name="parameters" action="build">
      <div name="parameter">
        <input type="hidden" name="name" value="ARTIFACT">
        <select name="value">
          <option value="a.zip" selected>a.zip</option>
          <option value="b.zip">b.zip</option>
        </select>
      </div>
      <div name="parameter">
        <input type="hidden" name="name" value="INTERNAL_TOKEN">
        <input type="hidden" name="value" value="server-only">
      </div>
      <div name="parameter">
        <input type="hidden" name="name" value="SECTION">
      </div>
    </form></body></html>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal crumb_calls, form_get_calls, job_get_calls
        if request.method == "GET" and request.url.path == "/job/api/api/json":
            job_get_calls += 1
            tree = request.url.params["tree"]
            return httpx.Response(
                200,
                json={
                    "name": "api",
                    "fullName": "api",
                    "buildable": True,
                    "actions": [{"parameterDefinitions": definitions(tree)}],
                },
            )
        if request.method == "GET" and request.url.path == "/job/api/build":
            form_get_calls += 1
            assert request.url.params["delay"] == "0sec"
            assert request.headers["Accept"] == "text/html,application/xhtml+xml"
            assert request.headers["Referer"] == "https://ci.example/job/api/"
            assert request.headers["User-Agent"].startswith("Mozilla/5.0")
            return httpx.Response(405, text=build_form, headers={"Content-Type": "text/html; charset=utf-8"})
        if request.method == "GET" and request.url.path == "/crumbIssuer/api/json":
            crumb_calls += 1
            return httpx.Response(
                200,
                json={"crumbRequestField": "Jenkins-Crumb", "crumb": "classic-crumb"},
            )
        if request.method == "POST" and request.url.path == "/job/api/build":
            assert "delay" not in request.url.params
            assert request.headers["Jenkins-Crumb"] == "classic-crumb"
            form = parse_qs(request.content.decode())
            classic_payloads.append(json.loads(form["json"][0]))
            return httpx.Response(201, headers={"Location": "/queue/item/23/"})
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
    instance_id = str(created["id"])

    metadata = await service.get_job(instance_id, job="api")
    prepared = await service.get_job(instance_id, job="api", include_parameter_options=True)
    queued = await service.trigger_build(
        instance_id,
        job="api",
        parameters={
            "ARTIFACT": "b.zip",
            "DEPLOY_PASSWORD": "runtime-secret",
            "INTERNAL_TOKEN": "client-override",
            "SECTION": "must-not-submit",
        },
    )

    assert [parameter["name"] for parameter in metadata["parameters"]] == [
        "ARTIFACT",
        "DEPLOY_PASSWORD",
        "SECTION",
        "DRY_RUN",
    ]
    assert metadata["parameters"][0]["options_state"] == "not_loaded"
    assert prepared["parameters"][0]["choices"] == ["a.zip", "b.zip"]
    assert prepared["parameters"][0]["options_state"] == "ready"
    assert prepared["parameters"][0]["default"] == "a.zip"
    assert prepared["parameters"][1]["type"] == "password"
    assert prepared["parameters"][1]["default"] is None
    assert prepared["parameters"][2]["type"] == "separator"
    assert prepared["parameters"][2]["header"] == "Deployment"
    assert prepared["requires_explicit_password"] is True
    assert "INTERNAL_TOKEN" not in json.dumps(prepared)
    assert "api-must-not-leak" not in json.dumps(prepared)
    assert "password-must-not-leak" not in json.dumps(prepared)
    assert "server-only" not in json.dumps(prepared)
    assert queued["id"] == 23
    assert classic_payloads == [
        {
            "parameter": [
                {"name": "ARTIFACT", "value": "b.zip"},
                {"name": "DEPLOY_PASSWORD", "value": "runtime-secret"},
                {"name": "DRY_RUN", "value": False},
                {"name": "INTERNAL_TOKEN", "value": "server-only"},
            ]
        }
    ]
    assert job_get_calls == 3
    assert form_get_calls == 2
    assert crumb_calls == 1
    await service.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("select_attributes", "options", "submitted", "message"),
    [
        ("", '<option value="current" selected>current</option>', "stale", "not one of"),
        ("", "", "current", "options are unavailable"),
    ],
    ids=["stale", "empty"],
)
async def test_dynamic_form_trigger_fails_closed_before_post(
    tmp_path: Path,
    select_attributes: str,
    options: str,
    submitted: str,
    message: str,
) -> None:
    credentials = FakeCredentialStore()
    crumb_calls = 0
    post_calls = 0
    build_form = f"""
    <form method="post" name="parameters" action="build">
      <div name="parameter">
        <input type="hidden" name="name" value="ARTIFACT">
        <select name="value" {select_attributes}>{options}</select>
      </div>
    </form>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal crumb_calls, post_calls
        if request.method == "GET" and request.url.path == "/job/api/api/json":
            return httpx.Response(
                200,
                json={
                    "name": "api",
                    "fullName": "api",
                    "actions": [
                        {
                            "parameterDefinitions": [
                                {
                                    "name": "ARTIFACT",
                                    "type": "FileSystemListParameterDefinition",
                                    "_class": "alex.jenkins.plugins.FileSystemListParameterDefinition",
                                }
                            ]
                        }
                    ],
                },
            )
        if request.method == "GET" and request.url.path == "/job/api/build":
            return httpx.Response(200, text=build_form)
        if request.method == "GET" and request.url.path == "/crumbIssuer/api/json":
            crumb_calls += 1
            return httpx.Response(404)
        if request.method == "POST":
            post_calls += 1
            return httpx.Response(201)
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
        await service.trigger_build(
            str(created["id"]),
            job="api",
            parameters={"ARTIFACT": submitted},
        )

    assert captured.value.status_code == 400
    assert crumb_calls == 0
    assert post_calls == 0
    await service.shutdown()


@pytest.mark.asyncio
async def test_active_choices_multi_select_is_validated_and_submitted_as_an_array(
    tmp_path: Path,
) -> None:
    credentials = FakeCredentialStore()
    crumb_calls = 0
    classic_payloads: list[dict[str, object]] = []
    build_form = """
    <form method="post" name="parameters" action="build">
      <div name="parameter">
        <input type="hidden" name="name" value="GROUP">
        <select name="value" multiple>
          <option value="server-a" selected>server-a</option>
          <option value="server-b">server-b</option>
        </select>
      </div>
    </form>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal crumb_calls
        if request.method == "GET" and request.url.path == "/job/api/api/json":
            return httpx.Response(
                200,
                json={
                    "name": "api",
                    "fullName": "api",
                    "actions": [
                        {
                            "parameterDefinitions": [
                                {
                                    "name": "GROUP",
                                    "type": "PT_MULTI_SELECT",
                                    "_class": "org.biouno.unochoice.ChoiceParameter",
                                    "choiceType": "PT_MULTI_SELECT",
                                }
                            ]
                        }
                    ],
                },
            )
        if request.method == "GET" and request.url.path == "/job/api/build":
            return httpx.Response(200, text=build_form)
        if request.method == "GET" and request.url.path == "/crumbIssuer/api/json":
            crumb_calls += 1
            return httpx.Response(200, json={"crumbRequestField": "Jenkins-Crumb", "crumb": "crumb"})
        if request.method == "POST" and request.url.path == "/job/api/build":
            form = parse_qs(request.content.decode())
            classic_payloads.append(json.loads(form["json"][0]))
            return httpx.Response(201, headers={"Location": "/queue/item/31/"})
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
    instance_id = str(created["id"])

    prepared = await service.get_job(instance_id, job="api", include_parameter_options=True)
    assert prepared["parameters"][0]["multiple"] is True
    assert prepared["parameters"][0]["default"] == ["server-a"]

    with pytest.raises(JenkinsApiError, match="not a current choice"):
        await service.trigger_build(instance_id, job="api", parameters={"GROUP": ["removed"]})

    queued = await service.trigger_build(
        instance_id,
        job="api",
        parameters={"GROUP": ["server-a", "server-b", "server-a"]},
    )

    assert queued["id"] == 31
    assert crumb_calls == 1
    assert classic_payloads == [
        {"parameter": [{"name": "GROUP", "value": ["server-a", "server-b"]}]}
    ]
    await service.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["redirect", "oversized"])
async def test_dynamic_option_form_does_not_follow_redirects_or_read_oversized_html(
    tmp_path: Path,
    mode: str,
) -> None:
    credentials = FakeCredentialStore()
    requested_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        if request.url.path == "/job/api/api/json":
            return httpx.Response(
                200,
                json={
                    "name": "api",
                    "fullName": "api",
                    "actions": [
                        {
                            "parameterDefinitions": [
                                {
                                    "name": "ARTIFACT",
                                    "type": "FileSystemListParameterDefinition",
                                    "_class": "alex.jenkins.plugins.FileSystemListParameterDefinition",
                                }
                            ]
                        }
                    ],
                },
            )
        if request.url.path == "/job/api/build" and mode == "redirect":
            return httpx.Response(302, headers={"Location": "https://other.example/secret-form"})
        if request.url.path == "/job/api/build":
            return httpx.Response(
                200,
                content=b"must-not-be-returned",
                headers={"Content-Length": str((1024 * 1024) + 1)},
            )
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

    job = await service.get_job(
        str(created["id"]),
        job="api",
        include_parameter_options=True,
    )

    assert job["parameters"][0]["options_state"] == "unavailable"
    assert job["parameters"][0]["choices"] is None
    assert len(requested_urls) == 2
    assert all("other.example" not in url for url in requested_urls)
    assert "must-not-be-returned" not in json.dumps(job)
    await service.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("configured_timeout", "expected_timeout"),
    [(5, 30), (45, 45), (120, 60)],
)
async def test_dynamic_build_form_uses_a_bounded_independent_timeout(
    configured_timeout: int,
    expected_timeout: int,
) -> None:
    observed_timeouts: list[dict[str, float]] = []
    build_form = """
    <form method="post" name="parameters" action="build">
      <div name="parameter">
        <input type="hidden" name="name" value="ARTIFACT">
        <select name="value"><option value="artifact.zip" selected>artifact.zip</option></select>
      </div>
    </form>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        timeout = request.extensions.get("timeout")
        assert isinstance(timeout, dict)
        observed_timeouts.append(timeout)
        return httpx.Response(200, text=build_form)

    gateway = JenkinsGateway(lambda _context: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    parameters = await gateway._get_build_parameter_form(
        instance(request_timeout=configured_timeout),
        "secret-token",
        job="api",
        expected_names={"ARTIFACT"},
    )

    assert parameters["ARTIFACT"].choices == ("artifact.zip",)
    assert len(observed_timeouts) == 1
    assert set(observed_timeouts[0].values()) == {float(expected_timeout)}
    await gateway.close()


@pytest.mark.asyncio
async def test_unknown_build_parameter_is_rejected_before_crumb_or_post(tmp_path: Path) -> None:
    credentials = FakeCredentialStore()
    crumb_calls = 0
    post_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal crumb_calls, post_calls
        if request.method == "GET" and request.url.path == "/job/api/api/json":
            return httpx.Response(
                200,
                json={
                    "name": "api",
                    "fullName": "api",
                    "actions": [
                        {
                            "parameterDefinitions": [
                                {
                                    "name": "ENV",
                                    "type": "StringParameterDefinition",
                                    "_class": "hudson.model.StringParameterDefinition",
                                }
                            ]
                        }
                    ],
                },
            )
        if request.method == "GET" and request.url.path == "/crumbIssuer/api/json":
            crumb_calls += 1
            return httpx.Response(404)
        if request.method == "POST":
            post_calls += 1
            return httpx.Response(201)
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

    with pytest.raises(JenkinsApiError, match="TYPO.*not defined") as captured:
        await service.trigger_build(
            str(created["id"]),
            job="api",
            parameters={"TYPO": "production"},
        )

    assert captured.value.status_code == 400
    assert crumb_calls == 0
    assert post_calls == 0
    await service.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("duplicate_in_actions", [False, True], ids=["property-only", "actions-property"])
async def test_property_parameter_definitions_are_normalized_deduplicated_and_triggered_once(
    tmp_path: Path,
    duplicate_in_actions: bool,
) -> None:
    credentials = FakeCredentialStore()
    job_get_calls = 0
    crumb_calls = 0
    post_paths: list[str] = []
    submitted_forms: list[dict[str, list[str]]] = []
    definitions = [
        {
            "name": "ENV",
            "_class": "hudson.model.ChoiceParameterDefinition",
            "description": "Target environment",
            "defaultParameterValue": {"value": "staging"},
            "choices": ["staging", "production"],
        },
        {
            "name": "DRY_RUN",
            "_class": "hudson.model.BooleanParameterDefinition",
            "description": "Validate without deploying",
            "defaultParameterValue": {"value": False},
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal crumb_calls, job_get_calls
        if request.method == "GET" and request.url.path == "/job/api/api/json":
            job_get_calls += 1
            assert "property[_class,parameterDefinitions[" in request.url.params["tree"]
            return httpx.Response(
                200,
                json={
                    "name": "api",
                    "fullName": "api",
                    "actions": [{"parameterDefinitions": definitions}] if duplicate_in_actions else [],
                    "property": [{"parameterDefinitions": definitions}],
                },
            )
        if request.method == "GET" and request.url.path == "/crumbIssuer/api/json":
            crumb_calls += 1
            return httpx.Response(
                200,
                json={"crumbRequestField": "Jenkins-Crumb", "crumb": "property-crumb"},
            )
        if request.method == "POST":
            post_paths.append(request.url.path)
            assert request.headers["Jenkins-Crumb"] == "property-crumb"
            submitted_forms.append(parse_qs(request.content.decode()))
            return httpx.Response(201, headers={"Location": "/queue/item/8/"})
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

    job = await service.get_job(str(created["id"]), job="api")
    queue = await service.trigger_build(
        str(created["id"]),
        job="api",
        parameters={"ENV": "production", "DRY_RUN": True},
    )

    assert job["parameters"] == [
        {
            "name": "ENV",
            "type": "choice",
            "raw_type": "hudson.model.ChoiceParameterDefinition",
            "description": "Target environment",
            "default": "staging",
            "choices": ["staging", "production"],
            "options_state": "ready",
            "multiple": False,
        },
        {
            "name": "DRY_RUN",
            "type": "boolean",
            "raw_type": "hudson.model.BooleanParameterDefinition",
            "description": "Validate without deploying",
            "default": False,
            "choices": None,
            "options_state": "not_applicable",
            "multiple": False,
        },
    ]
    assert job["parameterized"] is True
    assert queue["id"] == 8
    assert job_get_calls == 2
    assert crumb_calls == 1
    assert post_paths == ["/job/api/buildWithParameters"]
    assert submitted_forms == [{"ENV": ["production"], "DRY_RUN": ["true"]}]
    await service.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("definitions", "parameters", "message"),
    [
        ([], {"ENV": "production"}, "not parameterized"),
        (
            [
                {
                    "name": "ARCHIVE",
                    "type": "FileParameterDefinition",
                    "_class": "hudson.model.FileParameterDefinition",
                }
            ],
            {},
            "file parameters are not supported",
        ),
        (
            [
                {
                    "name": "ARCHIVE",
                    "type": "Base64FileParameterDefinition",
                    "_class": "io.jenkins.plugins.file_parameters.Base64FileParameterDefinition",
                }
            ],
            {},
            "file parameters are not supported",
        ),
        (
            [
                {
                    "name": "ARCHIVE",
                    "type": "StashedFileParameterDefinition",
                    "_class": "io.jenkins.plugins.file_parameters.StashedFileParameterDefinition",
                }
            ],
            {},
            "file parameters are not supported",
        ),
        (
            [
                {
                    "name": "AMI",
                    "type": "PT_SINGLE_SELECT",
                    "_class": "org.biouno.unochoice.CascadeChoiceParameter",
                }
            ],
            {},
            "parameter type is not supported",
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
