# Adapt the existing project

| Inspect | Adjustment before deployment |
| --- | --- |
| Only a development command | Select the project's production build/start, not a debug server. |
| Listener uses localhost | Bind the public service to 0.0.0.0 and its recorded port. |
| Browser calls localhost API | Use same-origin paths or inject the public API URL before building. |
| Redirects infer listener origin | Configure the registered tunnel URL explicitly. |
| Host-only command/files | Install the supported Linux dependency or adapt to its API; report unavailable dependencies. |
| Data under code or /tmp | Move to a persistent path outside releases, preserving existing data. |

Use the actual dependency manager and lockfile. These are examples, not a template:

| Project | Build argv steps | Foreground start argv |
| --- | --- | --- |
| Next.js | ["npm","ci"], ["npm","run","build"] | ["node","node_modules/next/dist/bin/next","start","-H","0.0.0.0","-p","3000"] |
| Node API | Project install/build scripts | Existing entrypoint configured for the recorded public port |
| Static frontend | Production build script | Project's production static server serving the generated directory |
| FastAPI | ["python3","-m","pip","install","-r","requirements.txt"] | ["python3","-m","uvicorn","main:app","--host","0.0.0.0","--port","8000"] |
| Flask | Requirements including production WSGI server | ["python3","-m","gunicorn","-b","0.0.0.0:8000","app:app"] |

Provide a ready-only 200 health endpoint. Keep server secrets in private guest environment; set public frontend build variables before building.
