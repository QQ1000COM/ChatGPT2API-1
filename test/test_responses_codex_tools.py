from __future__ import annotations

import base64

from services.protocol import openai_v1_response
from services.protocol.response_store import input_to_items
from utils.helper import responses_sse_stream


def test_responses_function_call_non_stream(monkeypatch):
    monkeypatch.setattr(
        openai_v1_response,
        "stream_text_deltas",
        lambda backend, request: iter([
            '{"type":"function_call","name":"shell","arguments":{"cmd":"pwd"}}'
        ]),
    )
    monkeypatch.setattr(openai_v1_response, "text_backend", lambda: object())

    response = openai_v1_response.handle({
        "model": "gpt-5.1-codex",
        "input": "show cwd",
        "tools": [{
            "type": "function",
            "name": "shell",
            "description": "Run a shell command",
            "parameters": {
                "type": "object",
                "properties": {"cmd": {"type": "string"}},
                "required": ["cmd"],
            },
        }],
    })

    assert isinstance(response, dict)
    assert response["status"] == "completed"
    assert response["output"][0]["type"] == "function_call"
    assert response["output"][0]["name"] == "shell"
    assert '"cmd": "pwd"' in response["output"][0]["arguments"]


def test_responses_function_call_stream(monkeypatch):
    monkeypatch.setattr(
        openai_v1_response,
        "stream_text_deltas",
        lambda backend, request: iter([
            '{"type":"function_call","name":"apply_patch","arguments":{"patch":"*** Begin Patch"}}'
        ]),
    )
    monkeypatch.setattr(openai_v1_response, "text_backend", lambda: object())

    events = list(openai_v1_response.handle({
        "model": "codex-mini-latest",
        "stream": True,
        "input": "edit file",
        "tools": [{"type": "function", "name": "apply_patch"}],
    }))

    assert any(event.get("type") == "response.function_call_arguments.delta" for event in events)
    assert any(event.get("type") == "response.output_item.added" for event in events)
    completed = [event for event in events if event.get("type") == "response.completed"][-1]
    assert completed["response"]["output"][0]["type"] == "function_call"


def test_responses_function_output_followup(monkeypatch):
    monkeypatch.setattr(
        openai_v1_response,
        "stream_text_deltas",
        lambda backend, request: iter(["Done."]),
    )
    monkeypatch.setattr(openai_v1_response, "text_backend", lambda: object())

    response = openai_v1_response.handle({
        "model": "gpt-5.1-codex",
        "input": [{
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "patched successfully",
        }],
        "tools": [{"type": "function", "name": "apply_patch"}],
    })

    assert isinstance(response, dict)
    assert response["output"][0]["type"] == "message"
    assert response["output"][0]["content"][0]["text"] == "Done."


def test_responses_text_stream_has_codex_event_sequence(monkeypatch):
    monkeypatch.setattr(openai_v1_response, "stream_text_deltas", lambda backend, request: iter(["hel", "lo"]))
    monkeypatch.setattr(openai_v1_response, "text_backend", lambda: object())

    events = list(openai_v1_response.handle({
        "model": "gpt-5.1-codex",
        "stream": True,
        "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}],
    }))

    event_types = [event["type"] for event in events]
    assert event_types[:3] == ["response.created", "response.output_item.added", "response.content_part.added"]
    assert "response.output_text.delta" in event_types
    assert "response.content_part.done" in event_types
    assert events[-1]["response"]["output_text"] == "hello"


def test_responses_sse_stream_includes_event_names():
    body = "".join(responses_sse_stream([
        {"type": "response.created", "response": {"id": "resp_1"}},
        {"type": "response.completed", "response": {"id": "resp_1"}},
    ]))

    assert "event: response.created" in body
    assert "event: response.completed" in body
    assert '"sequence_number": 0' in body
    assert "event: done" in body


def test_response_store_preserves_function_call_output_items():
    items = input_to_items([
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "run"}]},
        {"type": "function_call_output", "call_id": "call_1", "output": "ok"},
    ])

    assert items[0]["type"] == "message"
    assert items[1]["type"] == "function_call_output"
    assert items[1]["call_id"] == "call_1"


def test_codex_large_context_is_compacted_before_upstream():
    huge_context = (
        "<permissions instructions>" + ("x" * 20000) + "</permissions instructions>\n"
        "<app-context>" + ("y" * 30000) + "</app-context>\n"
        "<skills_instructions>" + ("z" * 30000) + "</skills_instructions>\n"
        "Real task: edit the project files."
    )

    model, messages = openai_v1_response.text_response_parts({
        "model": "gpt-5.5",
        "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": huge_context}]}],
    })

    combined = "\n".join(str(message.get("content") or "") for message in messages)
    assert model == "gpt-5.5"
    assert "Real task: edit the project files." in combined
    assert "codex client context omitted" in combined
    assert len(combined) < 5000


def test_responses_input_image_is_preserved_for_upstream(monkeypatch):
    seen = {}
    image_b64 = base64.b64encode(b"fake-png-bytes").decode("ascii")

    def fake_stream_text_deltas(_backend, request):
        seen["messages"] = request.messages
        return iter(["I can see the image."])

    monkeypatch.setattr(openai_v1_response, "stream_text_deltas", fake_stream_text_deltas)
    monkeypatch.setattr(openai_v1_response, "text_backend", lambda: object())

    response = openai_v1_response.handle({
        "model": "gpt-5.5",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "What is this?"},
                {"type": "input_image", "image_url": f"data:image/png;base64,{image_b64}"},
            ],
        }],
    })

    assert isinstance(response, dict)
    content = seen["messages"][0]["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "What is this?"}
    assert content[1]["type"] == "image"
    assert content[1]["data"] == b"fake-png-bytes"
    assert content[1]["mime"] == "image/png"
