from __future__ import annotations

from services.openai_backend_api import OpenAIBackendAPI
from services.protocol.openai_search import MODEL, resolve_model


def test_search_model_auto_falls_back_to_search_model():
    assert resolve_model(None) == MODEL
    assert resolve_model("") == MODEL
    assert resolve_model("auto") == MODEL
    assert resolve_model("gpt-5") == "gpt-5"


def test_extract_search_result_collects_answer_and_sources():
    client = OpenAIBackendAPI("token")
    result = client._extract_search_result(
        "conv_123",
        {
            "mapping": {
                "node_1": {
                    "message": {
                        "id": "msg_1",
                        "author": {"role": "assistant"},
                        "create_time": 10,
                        "content": {"parts": ["答案见 https://example.com/page"]},
                        "metadata": {
                            "finish_details": {"type": "finished_successfully"},
                            "search_result_groups": [
                                {
                                    "entries": [
                                        {
                                            "title": "Example",
                                            "url": "https://example.com/page",
                                            "snippet": "A source",
                                            "type": "webpage",
                                        }
                                    ]
                                }
                            ],
                        },
                    }
                }
            }
        },
    )

    assert result["conversation_id"] == "conv_123"
    assert result["status"] == "finished_successfully"
    assert result["answer"] == "答案见 https://example.com/page"
    assert result["sources"] == [
        {
            "title": "Example",
            "url": "https://example.com/page",
            "snippet": "A source",
            "source_type": "webpage",
        }
    ]
