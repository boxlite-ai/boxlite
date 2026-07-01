export type OnboardingInterface = 'python' | 'typescript' | 'go' | 'rust' | 'c' | 'cli' | 'rest'

export interface OnboardingCodeExample {
  install: string
  run: string
  example: string
  codeLanguage: string
  setupLabel?: string
  setupDescription?: string
}

const codeExamples: Record<OnboardingInterface, OnboardingCodeExample> = {
  typescript: {
    install: 'npm install @boxlite-ai/boxlite tsx',
    run: 'BOXLITE_API_KEY=$KEY npx tsx index.mts',
    codeLanguage: 'typescript',
    example: `import { ApiKeyCredential, BoxliteRestOptions, JsBoxlite } from '@boxlite-ai/boxlite'

const apiKey = process.env.BOXLITE_API_KEY
if (!apiKey) {
  throw new Error('Set BOXLITE_API_KEY before running this script')
}

const rt = JsBoxlite.rest(new BoxliteRestOptions({
  url: process.env.BOXLITE_REST_URL ?? 'your-api-url',
  credential: new ApiKeyCredential(apiKey),
}))

const box = await rt.create({ image: 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3' }, 'sdk-quickstart')
await box.start()

const exec = await box.exec('echo', ['Hello from BoxLite SDK'])
const stdout = await exec.stdout()
let output = ''
let chunk: string | null
while ((chunk = await stdout.next()) !== null) {
  output += chunk
}
const result = await exec.wait()
console.log('Exit code:', result.exitCode)
console.log(output)

await rt.remove(box.id, true)`,
  },
  python: {
    install: 'pip install boxlite',
    run: 'BOXLITE_API_KEY=$KEY python main.py',
    codeLanguage: 'python',
    example: `import asyncio
import os
from boxlite import ApiKeyCredential, Boxlite, BoxliteRestOptions, BoxOptions

async def main():
    rt = Boxlite.rest(BoxliteRestOptions(
        url=os.environ.get("BOXLITE_REST_URL", "your-api-url"),
        credential=ApiKeyCredential(os.environ["BOXLITE_API_KEY"]),
    ))

    box = await rt.create(BoxOptions(image="ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3"), name="sdk-quickstart")
    await box.start()

    execution = await box.exec("echo", args=["Hello from BoxLite SDK"])
    output = ""
    async for line in execution.stdout():
        output += line
    result = await execution.wait()
    print(f"Exit code: {result.exit_code}")
    print(output)

    await rt.remove(box.id, force=True)

asyncio.run(main())`,
  },
  go: {
    install: `go get github.com/boxlite-ai/boxlite/sdks/go
go run github.com/boxlite-ai/boxlite/sdks/go/cmd/setup`,
    run: 'BOXLITE_API_KEY=$KEY go run .',
    codeLanguage: 'go',
    example: `package main

import (
    "context"
    "log"
    "os"

    boxlite "github.com/boxlite-ai/boxlite/sdks/go"
)

func main() {
    ctx := context.Background()
    apiKey := os.Getenv("BOXLITE_API_KEY")
    if apiKey == "" {
        log.Fatal("Set BOXLITE_API_KEY before running this program")
    }

    apiURL := os.Getenv("BOXLITE_REST_URL")
    if apiURL == "" {
        apiURL = "your-api-url"
    }

    rt, err := boxlite.NewRest(boxlite.BoxliteRestOptions{
        URL:        apiURL,
        Credential: boxlite.NewApiKeyCredential(apiKey),
    })
    if err != nil {
        log.Fatal(err)
    }
    defer rt.Close()

    box, err := rt.Create(ctx, "ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3", boxlite.WithName("sdk-quickstart"))
    if err != nil {
        log.Fatal(err)
    }
    if err := box.Start(ctx); err != nil {
        log.Fatal(err)
    }

    result, err := box.Exec(ctx, "echo", "Hello from BoxLite SDK")
    if err != nil {
        log.Fatal(err)
    }
    log.Println("Exit code:", result.ExitCode)
    log.Print(result.Stdout)

    if err := rt.ForceRemove(ctx, box.ID()); err != nil {
        log.Fatal(err)
    }
}`,
  },
  rust: {
    install: `cargo add boxlite --features rest
cargo add tokio --features macros,rt-multi-thread
cargo add futures`,
    run: 'BOXLITE_API_KEY=$KEY cargo run',
    codeLanguage: 'rust',
    example: `use boxlite::{BoxCommand, BoxOptions, BoxliteRestOptions, BoxliteRuntime, RootfsSpec};
use futures::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api_key = std::env::var("BOXLITE_API_KEY")?;
    let api_url = std::env::var("BOXLITE_REST_URL").unwrap_or_else(|_| "your-api-url".to_owned());
    let rt = BoxliteRuntime::rest(
        BoxliteRestOptions::new(api_url).with_api_key(api_key),
    )?;

    let options = BoxOptions {
        rootfs: RootfsSpec::Image("ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3".into()),
        ..Default::default()
    };
    let box_handle = rt.create(options, Some("sdk-quickstart".into())).await?;
    box_handle.start().await?;

    let exec = box_handle
        .exec(BoxCommand::new("echo").arg("Hello from BoxLite SDK"))
        .await?;
    let mut stdout = exec.stdout().expect("stdout stream should be available");
    let mut output = String::new();
    while let Some(line) = stdout.next().await {
        output.push_str(&line);
    }
    let result = exec.wait().await?;
    println!("Exit code: {}", result.exit_code);
    print!("{output}");

    rt.remove(&box_handle.id().to_string(), true).await?;
    Ok(())
}`,
  },
  c: {
    install: `VERSION=v0.9.5
PLATFORM=darwin-arm64
# Linux: PLATFORM=linux-x64-gnu or linux-arm64-gnu
curl -fsSL "https://github.com/boxlite-ai/boxlite/releases/download/\${VERSION}/boxlite-c-\${VERSION}-\${PLATFORM}.tar.gz" \\
  | tar xz
mv "boxlite-c-\${VERSION}-\${PLATFORM}" boxlite-c-sdk`,
    run: `cc main.c -Iboxlite-c-sdk/include -Lboxlite-c-sdk/lib -lboxlite \\
  -Wl,-rpath,"$PWD/boxlite-c-sdk/lib" -o quickstart
BOXLITE_API_KEY=$KEY BOXLITE_REST_URL=your-api-url ./quickstart`,
    codeLanguage: 'c',
    setupLabel: 'Download C SDK',
    setupDescription:
      'Downloads the prebuilt C header and native library. The next step includes boxlite.h and links libboxlite.',
    example: `#include "boxlite.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
    CBoxliteRuntime *runtime;
    CBoxHandle *box;
    CExecutionHandle *exec;
    int done;
    int failed;
    int exit_code;
} Quickstart;

static int has_error(const CBoxliteError *error) {
    return error && error->code != Ok;
}

static void print_error(const char *op, CBoxliteError *error) {
    fprintf(stderr, "%s failed: %s\\n", op, error && error->message ? error->message : "unknown");
    if (error) {
        boxlite_error_free(error);
    }
}

static void require_ok(BoxliteErrorCode code, const char *op, CBoxliteError *error) {
    if (code != Ok) {
        print_error(op, error);
        exit(1);
    }
}

static void on_create(CBoxHandle *box, CBoxliteError *error, void *user_data) {
    Quickstart *qs = (Quickstart *)user_data;
    if (has_error(error)) {
        print_error("create box", error);
        qs->failed = 1;
    } else {
        qs->box = box;
    }
    qs->done = 1;
}

static void on_done(CBoxliteError *error, void *user_data) {
    Quickstart *qs = (Quickstart *)user_data;
    if (has_error(error)) {
        print_error("operation", error);
        qs->failed = 1;
    }
    qs->done = 1;
}

static void on_wait(int exit_code, CBoxliteError *error, void *user_data) {
    Quickstart *qs = (Quickstart *)user_data;
    if (has_error(error)) {
        print_error("wait", error);
        qs->failed = 1;
    }
    qs->exit_code = exit_code;
    qs->done = 1;
}

static void on_stdout(const uint8_t *data, size_t len, void *user_data) {
    (void)user_data;
    fwrite(data, 1, len, stdout);
}

static void drain_until_done(Quickstart *qs) {
    CBoxliteError error = {0};
    while (!qs->done) {
        if (boxlite_runtime_drain(qs->runtime, -1, &error) < 0) {
            print_error("drain", &error);
            exit(1);
        }
    }
    if (qs->failed) {
        exit(1);
    }
    qs->done = 0;
}

int main(void) {
    const char *api_key = getenv("BOXLITE_API_KEY");
    const char *api_url = getenv("BOXLITE_REST_URL");
    if (!api_key) {
        fprintf(stderr, "Set BOXLITE_API_KEY before running this program\\n");
        return 1;
    }
    if (!api_url) {
        api_url = "your-api-url";
    }

    CBoxliteError error = {0};
    CBoxliteCredential *credential = NULL;
    CBoxliteRestOptions *rest = NULL;
    CBoxliteOptions *box_options = NULL;
    Quickstart qs = {0};

    require_ok(boxlite_api_key_credential_new(api_key, &credential, &error), "credential", &error);
    require_ok(boxlite_rest_options_new(api_url, &rest, &error), "rest options", &error);
    boxlite_rest_options_set_credential(rest, credential);
    require_ok(boxlite_rest_runtime_new_with_options(rest, &qs.runtime, &error), "rest runtime", &error);

    require_ok(
        boxlite_options_new("ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3", &box_options, &error),
        "box options",
        &error
    );
    boxlite_options_set_name(box_options, "sdk-quickstart");
    require_ok(boxlite_create_box(qs.runtime, box_options, on_create, &qs, &error), "create box", &error);
    drain_until_done(&qs);

    require_ok(boxlite_start_box(qs.box, on_done, &qs, &error), "start box", &error);
    drain_until_done(&qs);

    const char *args[] = {"Hello from BoxLite C SDK"};
    BoxliteCommand cmd = {.command = "echo", .args = args, .argc = 1};
    require_ok(boxlite_box_exec(qs.box, &cmd, &qs.exec, &error), "exec", &error);
    require_ok(boxlite_execution_on_stdout(qs.exec, on_stdout, NULL, &error), "stdout", &error);
    require_ok(boxlite_execution_wait(qs.exec, on_wait, &qs, &error), "wait", &error);
    drain_until_done(&qs);
    printf("Exit code: %d\\n", qs.exit_code);

    char *box_id = boxlite_box_id(qs.box);
    require_ok(boxlite_remove(qs.runtime, box_id, 1, on_done, &qs, &error), "remove box", &error);
    drain_until_done(&qs);
    boxlite_free_string(box_id);

    boxlite_execution_free(qs.exec);
    boxlite_box_free(qs.box);
    boxlite_options_free(box_options);
    boxlite_rest_options_free(rest);
    boxlite_credential_free(credential);
    boxlite_runtime_free(qs.runtime);
    return qs.exit_code;
}`,
  },
  cli: {
    install: 'curl -fsSL https://sh.boxlite.ai | sh',
    run: `BOXLITE_API_KEY=$KEY BOXLITE_REST_URL=your-api-url boxlite run --rm --name "sdk-quickstart-cli-$(date +%s)" \\
  ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3 \\
  echo "Hello from BoxLite CLI"`,
    codeLanguage: 'bash',
    setupLabel: 'Install CLI',
    setupDescription:
      'Installs the boxlite command. The next step uses it directly with BOXLITE_API_KEY and BOXLITE_REST_URL.',
    example: `if [ -z "\${BOXLITE_API_KEY:-}" ]; then
  printf "Paste your BoxLite API key from Step 1: " >&2
  stty -echo
  IFS= read -r BOXLITE_API_KEY
  stty echo
  printf "\\n" >&2
fi
export BOXLITE_API_KEY
export BOXLITE_REST_URL="your-api-url"

boxlite run --rm --name "sdk-quickstart-cli-$(date +%s)" \\
  ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3 \\
  echo "Hello from BoxLite CLI"`,
  },
  rest: {
    install: `command -v curl
command -v jq`,
    run: 'BOXLITE_API_KEY=$KEY BOXLITE_REST_URL=your-api-url bash quickstart-rest.sh',
    codeLanguage: 'bash',
    setupLabel: 'Check REST tools',
    setupDescription:
      'REST does not require an SDK install. The next step uses curl and jq to create a Box and execute a command. OpenAPI is available for full endpoint reference and generated clients.',
    example: `#!/usr/bin/env bash
set -euo pipefail

if [ -z "\${BOXLITE_API_KEY:-}" ]; then
  printf "Paste your BoxLite API key from Step 1: " >&2
  stty -echo
  IFS= read -r BOXLITE_API_KEY
  stty echo
  printf "\\n" >&2
fi
export BOXLITE_API_KEY
BOXLITE_REST_URL="\${BOXLITE_REST_URL:-your-api-url}"
auth=(-H "Authorization: Bearer \${BOXLITE_API_KEY}")
json=(-H "Content-Type: application/json")
name="sdk-quickstart-rest-$(date +%s)"

box_id="$(
  curl -fsS -X POST "\${BOXLITE_REST_URL}/v1/boxes" \\
    "\${auth[@]}" "\${json[@]}" \\
    -d "{\\"name\\":\\"\${name}\\",\\"image\\":\\"ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3\\"}" \\
    | jq -r '.box_id'
)"
trap 'curl -fsS -X DELETE "\${BOXLITE_REST_URL}/v1/boxes/\${box_id}?force=true" "\${auth[@]}" >/dev/null || true' EXIT

curl -fsS -X POST "\${BOXLITE_REST_URL}/v1/boxes/\${box_id}/start" "\${auth[@]}" >/dev/null

exec_id="$(
  curl -fsS -X POST "\${BOXLITE_REST_URL}/v1/boxes/\${box_id}/exec" \\
    "\${auth[@]}" "\${json[@]}" \\
    -d '{"command":"echo","args":["Hello from BoxLite REST"]}' \\
    | jq -r '.execution_id'
)"

curl -fsS "\${BOXLITE_REST_URL}/v1/boxes/\${box_id}/executions/\${exec_id}" "\${auth[@]}" | jq`,
  },
}

export function getOnboardingCodeExamples(): Record<OnboardingInterface, OnboardingCodeExample> {
  return codeExamples
}
