#!/usr/bin/env python3
"""
Research agent example.

Accepts a question, searches the web, asks an OpenAI-compatible chat
completion endpoint to synthesize an answer, and prints the final response.

When this runs inside a BoxLite box, the API key can be supplied as a BoxLite
secret placeholder. The real key stays on the host side and gvproxy substitutes
it only when the request reaches the configured LLM API host.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import textwrap
import urllib.parse
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Iterable


DEFAULT_USER_AGENT = "boxlite-research-agent/0.1"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_OPENAI_MODEL = "gpt-4.1-mini"


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str


class DuckDuckGoHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.results: list[SearchResult] = []
        self._in_title = False
        self._in_snippet = False
        self._title_parts: list[str] = []
        self._snippet_parts: list[str] = []
        self._current_url = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = dict(attrs)
        classes = attrs_dict.get("class", "")
        if tag == "a" and ("result__a" in classes or "result-link" in classes):
            self._in_title = True
            self._title_parts = []
            self._snippet_parts = []
            self._current_url = attrs_dict.get("href") or ""
        elif tag in {"a", "div", "td"} and ("result__snippet" in classes or "result-snippet" in classes):
            self._in_snippet = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_title:
            self._in_title = False
        elif tag in {"a", "div", "td"} and self._in_snippet:
            self._in_snippet = False
            title = clean_text(" ".join(self._title_parts))
            snippet = clean_text(" ".join(self._snippet_parts))
            if title and self._current_url:
                self.results.append(SearchResult(title=title, url=normalize_ddg_url(self._current_url), snippet=snippet))

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)
        elif self._in_snippet:
            self._snippet_parts.append(data)


def clean_text(value: str) -> str:
    return " ".join(html.unescape(value).split())


def normalize_ddg_url(url: str) -> str:
    if url.startswith("//"):
        url = f"https:{url}"
    parsed = urllib.parse.urlparse(url)
    query = urllib.parse.parse_qs(parsed.query)
    if "uddg" in query:
        return query["uddg"][0]
    return url


def search_duckduckgo(question: str, limit: int, timeout: float) -> list[SearchResult]:
    params = urllib.parse.urlencode({"q": question})
    for endpoint in ("https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"):
        request = urllib.request.Request(
            f"{endpoint}?{params}",
            headers={"User-Agent": DEFAULT_USER_AGENT},
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")

        parser = DuckDuckGoHTMLParser()
        parser.feed(body)
        if parser.results:
            return parser.results[:limit]

    return []


def search_from_fixture(path: str, limit: int) -> list[SearchResult]:
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    results = []
    for item in payload[:limit]:
        results.append(SearchResult(title=item["title"], url=item["url"], snippet=item.get("snippet", "")))
    return results


def format_context(results: Iterable[SearchResult]) -> str:
    lines = []
    for index, result in enumerate(results, start=1):
        lines.append(f"[{index}] {result.title}\nURL: {result.url}\nSnippet: {result.snippet}")
    return "\n\n".join(lines)


def build_answer_prompt(question: str, results: list[SearchResult]) -> str:
    return textwrap.dedent(
        f"""
        You are a concise research agent. Answer the user's question using the
        web search results below. Cite sources inline as [1], [2], etc. If the
        search results are insufficient, say what is missing.

        Question:
        {question}

        Search results:
        {format_context(results)}
        """
    ).strip()


def openai_api_key() -> str | None:
    return os.getenv("OPENAI_API_KEY") or os.getenv("BOXLITE_SECRET_OPENAI_API_KEY")


def ask_openai(prompt: str, model: str, base_url: str, timeout: float) -> str:
    api_key = openai_api_key()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY or BOXLITE_SECRET_OPENAI_API_KEY is required")

    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You answer with concise, cited research summaries.",
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
    }
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": DEFAULT_USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI request failed with HTTP {exc.code}: {body[:500]}") from exc

    data = json.loads(body)
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError(f"OpenAI response did not include choices: {body[:500]}")
    message = choices[0].get("message") or {}
    return str(message.get("content", "")).strip()


def ask_echo(question: str, results: list[SearchResult]) -> str:
    if not results:
        return f"No search results were available for: {question}"
    bullets = "\n".join(f"- [{idx}] {result.title}: {result.snippet}" for idx, result in enumerate(results, start=1))
    return f"Echo provider summary for: {question}\n\n{bullets}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Search the web, ask an LLM, and answer a question.")
    parser.add_argument("question", nargs="+", help="Question to answer")
    parser.add_argument("--search-provider", choices=["duckduckgo", "fixture"], default=os.getenv("RESEARCH_AGENT_SEARCH_PROVIDER", "duckduckgo"))
    parser.add_argument("--search-fixture", default=os.getenv("RESEARCH_AGENT_SEARCH_FIXTURE"))
    parser.add_argument("--answer-provider", choices=["openai", "echo"], default=os.getenv("RESEARCH_AGENT_ANSWER_PROVIDER", "echo"))
    parser.add_argument("--openai-model", default=os.getenv("OPENAI_MODEL", DEFAULT_OPENAI_MODEL))
    parser.add_argument("--openai-base-url", default=os.getenv("OPENAI_BASE_URL", DEFAULT_OPENAI_BASE_URL))
    parser.add_argument("--limit", type=int, default=int(os.getenv("RESEARCH_AGENT_SEARCH_LIMIT", "5")))
    parser.add_argument("--timeout", type=float, default=float(os.getenv("RESEARCH_AGENT_TIMEOUT", "20")))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    question = " ".join(args.question)

    if args.search_provider == "fixture":
        if not args.search_fixture:
            raise SystemExit("--search-fixture is required with fixture search provider")
        results = search_from_fixture(args.search_fixture, args.limit)
    else:
        results = search_duckduckgo(question, args.limit, args.timeout)

    prompt = build_answer_prompt(question, results)
    if args.answer_provider == "openai":
        answer = ask_openai(prompt, args.openai_model, args.openai_base_url, args.timeout)
    else:
        answer = ask_echo(question, results)

    print(answer)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
