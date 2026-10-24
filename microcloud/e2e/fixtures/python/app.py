# A Python app the way agents write one: pip-installed gunicorn started by its bare name,
# psycopg with the platform's DATABASE_URL exactly as given.
import os
import psycopg


def app(environ, start_response):
    path = environ.get("PATH_INFO", "/")
    if path == "/healthz":
        body = b"ok"
    elif path == "/db":
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            conn.execute("INSERT INTO visits DEFAULT VALUES")
            body = str(conn.execute("SELECT count(*) FROM visits").fetchone()[0]).encode()
    else:
        body = b"python ok"
    start_response("200 OK", [("Content-Type", "text/plain")])
    return [body]
