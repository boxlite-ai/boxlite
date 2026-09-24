# Integration examples

## FastAPI integration

Expose BoxLite as a REST API:

```python
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import boxlite
import asyncio

app = FastAPI()

class CodeRequest(BaseModel):
    code: str
    timeout: int = 30

@app.post("/execute")
async def execute_code(request: CodeRequest):
    """Execute Python code in isolated box."""
    try:
        async with boxlite.CodeBox() as codebox:
            result = await asyncio.wait_for(
                codebox.run(request.code),
                timeout=request.timeout
            )
            return {"output": result}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408, detail="Execution timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Run: uvicorn main:app --reload
```

## Celery task queue

Background task processing with BoxLite:

```python
from celery import Celery
import boxlite
import asyncio

app = Celery('tasks', broker='redis://localhost:6379')

@app.task
def run_code_task(code: str):
    """Run code in box as background task."""
    async def execute():
        async with boxlite.CodeBox() as codebox:
            return await codebox.run(code)

    return asyncio.run(execute())

# Usage: run_code_task.delay("print('Hello')")
```

## Serverless function handler

AWS Lambda / Cloud Functions integration:

```python
import boxlite
import asyncio

def handler(event, context):
    """Serverless function handler."""
    code = event.get('code', '')

    async def execute():
        async with boxlite.SimpleBox(image="python:slim") as box:
            result = await box.exec("python", "-c", code)
            return {
                'statusCode': 200,
                'body': result.stdout
            }

    return asyncio.run(execute())
```
