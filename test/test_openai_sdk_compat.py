from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.ai as ai_module
from services.config import config


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {config.auth_key}"}


def make_client(monkeypatch):
    monkeypatch.setattr(ai_module, "check_request", lambda _text: None)
    monkeypatch.setattr(ai_module.config, "add_admin_usage", lambda **_kwargs: {})
    app = FastAPI()
    app.include_router(ai_module.create_router())
    return TestClient(app)


def test_openai_sdk_compat_chat_responses_images_models_and_stream(monkeypatch):
    client = make_client(monkeypatch)

    monkeypatch.setattr(
        ai_module.openai_v1_models,
        "list_models",
        lambda: {"object": "list", "data": [{"id": "gpt-test", "object": "model"}]},
    )
    models = client.get("/v1/models", headers=auth_headers())
    assert models.status_code == 200
    assert models.json()["data"][0]["id"] == "gpt-test"

    monkeypatch.setattr(
        ai_module.openai_v1_chat_complete,
        "handle",
        lambda _payload: {"id": "chatcmpl_test", "object": "chat.completion", "choices": [{"message": {"role": "assistant", "content": "ok"}}]},
    )
    chat = client.post("/v1/chat/completions", headers=auth_headers(), json={"model": "gpt-test", "messages": [{"role": "user", "content": "hi"}]})
    assert chat.status_code == 200
    assert chat.json()["choices"][0]["message"]["content"] == "ok"

    monkeypatch.setattr(
        ai_module.openai_v1_chat_complete,
        "handle",
        lambda _payload: iter([
            {"id": "chatcmpl_test", "object": "chat.completion.chunk", "choices": [{"delta": {"content": "o"}}]},
            {"id": "chatcmpl_test", "object": "chat.completion.chunk", "choices": [{"delta": {"content": "k"}}]},
        ]),
    )
    with client.stream("POST", "/v1/chat/completions", headers=auth_headers(), json={"model": "gpt-test", "stream": True, "messages": [{"role": "user", "content": "hi"}]}) as stream:
        assert stream.status_code == 200
        body = "".join(stream.iter_text())
    assert "chat.completion.chunk" in body


def test_responses_admin_usage_records_completed_usage(monkeypatch):
    calls = []
    client = make_client(monkeypatch)
    monkeypatch.setattr(ai_module.config, "add_admin_usage", lambda **kwargs: calls.append(kwargs) or {"usage": {}})

    monkeypatch.setattr(
        ai_module.openai_v1_response,
        "handle",
        lambda _payload: {
            "id": "resp_usage",
            "object": "response",
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}],
            "usage": {"input_tokens": 11, "output_tokens": 7},
        },
    )
    response = client.post("/v1/responses", headers=auth_headers(), json={"model": "gpt-test", "input": "hi"})

    assert response.status_code == 200
    assert calls[-1]["endpoint"] == "responses"
    assert calls[-1]["input_tokens"] == 11
    assert calls[-1]["output_tokens"] == 7

    monkeypatch.setattr(
        ai_module.openai_v1_response,
        "handle",
        lambda _payload: iter([
            {"type": "response.created", "response": {"id": "resp_stream_usage", "object": "response", "status": "in_progress", "output": []}},
            {
                "type": "response.completed",
                "response": {
                    "id": "resp_stream_usage",
                    "object": "response",
                    "status": "completed",
                    "output": [],
                    "usage": {"input_tokens": 5, "output_tokens": 3},
                },
            },
        ]),
    )
    with client.stream("POST", "/v1/responses", headers=auth_headers(), json={"model": "gpt-test", "stream": True, "input": "hi"}) as stream:
        assert stream.status_code == 200
        _ = "".join(stream.iter_text())

    assert calls[-1]["endpoint"] == "responses"
    assert calls[-1]["input_tokens"] == 5
    assert calls[-1]["output_tokens"] == 3

    monkeypatch.setattr(
        ai_module.openai_v1_response,
        "handle",
        lambda _payload: {"id": "resp_test", "object": "response", "status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}]},
    )
    response = client.post("/v1/responses", headers=auth_headers(), json={"model": "gpt-test", "input": "hi"})
    assert response.status_code == 200
    assert response.json()["id"] == "resp_test"
    retrieved = client.get("/v1/responses/resp_test", headers=auth_headers())
    assert retrieved.status_code == 200
    assert retrieved.json()["id"] == "resp_test"

    monkeypatch.setattr(
        ai_module.openai_v1_response,
        "handle",
        lambda _payload: iter([
            {"type": "response.created", "response": {"id": "resp_stream", "object": "response", "status": "in_progress", "output": []}},
            {"type": "response.completed", "response": {"id": "resp_stream", "object": "response", "status": "completed", "output": []}},
        ]),
    )
    with client.stream("POST", "/v1/responses", headers=auth_headers(), json={"model": "gpt-test", "stream": True, "input": "hi"}) as stream:
        assert stream.status_code == 200
        response_stream_body = "".join(stream.iter_text())
    assert "event: response.created" in response_stream_body
    assert "event: response.completed" in response_stream_body
    retrieved_stream = client.get("/v1/responses/resp_stream", headers=auth_headers())
    assert retrieved_stream.status_code == 200

    monkeypatch.setattr(
        ai_module.openai_v1_image_generations,
        "handle",
        lambda _payload: {"created": 1, "data": [{"url": "http://testserver/images/fake.png"}]},
    )
    image = client.post("/v1/images/generations", headers=auth_headers(), json={"model": "gpt-image-2", "prompt": "cat", "n": 1})
    assert image.status_code == 200
    assert image.json()["data"][0]["url"].endswith("/images/fake.png")
