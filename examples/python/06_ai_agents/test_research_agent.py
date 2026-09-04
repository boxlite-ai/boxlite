import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("research_agent.py")
spec = importlib.util.spec_from_file_location("research_agent", MODULE_PATH)
research_agent = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules["research_agent"] = research_agent
spec.loader.exec_module(research_agent)


class ResearchAgentTest(unittest.TestCase):
    def test_duckduckgo_lite_parser_extracts_results(self):
        parser = research_agent.DuckDuckGoHTMLParser()
        parser.feed(
            """
            <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com" class='result-link'>
              Example Result
            </a>
            <td class='result-snippet'>A useful result snippet.</td>
            """
        )

        self.assertEqual(len(parser.results), 1)
        self.assertEqual(parser.results[0].title, "Example Result")
        self.assertEqual(parser.results[0].url, "https://example.com")
        self.assertEqual(parser.results[0].snippet, "A useful result snippet.")

    def test_fixture_search_and_prompt_include_citations(self):
        fixture = Path(__file__).with_name("research_agent_fixture.json")
        results = research_agent.search_from_fixture(str(fixture), limit=2)
        prompt = research_agent.build_answer_prompt("Question?", results)

        self.assertIn("Question?", prompt)
        self.assertIn("[1] BoxLite AI agent examples", prompt)
        self.assertIn("[2] Codex tool-use loop", prompt)

    def test_openai_provider_uses_boxlite_secret_placeholder(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return json.dumps({
                    "choices": [
                        {"message": {"content": "Answer from model with [1]."}}
                    ]
                }).encode()

        captured = {}

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return FakeResponse()

        with mock.patch.dict(
            os.environ,
            {
                "BOXLITE_SECRET_OPENAI_API_KEY": "<BOXLITE_SECRET:openai_api_key>",
            },
            clear=True,
        ), mock.patch.object(research_agent.urllib.request, "urlopen", fake_urlopen):
            answer = research_agent.ask_openai(
                "Prompt",
                model="gpt-test",
                base_url="https://api.openai.com/v1",
                timeout=7,
            )

        self.assertEqual(answer, "Answer from model with [1].")
        request = captured["request"]
        self.assertEqual(captured["timeout"], 7)
        self.assertEqual(
            request.headers["Authorization"],
            "Bearer <BOXLITE_SECRET:openai_api_key>",
        )
        body = json.loads(request.data.decode())
        self.assertEqual(body["model"], "gpt-test")
        self.assertEqual(body["messages"][1]["content"], "Prompt")


if __name__ == "__main__":
    unittest.main()
