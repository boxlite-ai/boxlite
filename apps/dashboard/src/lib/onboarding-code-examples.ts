export type OnboardingLanguage = 'python' | 'typescript' | 'go' | 'rust'

export interface OnboardingCodeExample {
  install: string
  run: string
  example: string
  codeLanguage: string
}

const codeExamples: Record<OnboardingLanguage, OnboardingCodeExample> = {
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

const box = await rt.create({ image: 'boxlite/base' }, 'sdk-quickstart')
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

    box = await rt.create(BoxOptions(image="boxlite/base"), name="sdk-quickstart")
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

    box, err := rt.Create(ctx, "boxlite/base", boxlite.WithName("sdk-quickstart"))
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
        rootfs: RootfsSpec::Image("boxlite/base".into()),
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
}

export function getOnboardingCodeExamples(): Record<OnboardingLanguage, OnboardingCodeExample> {
  return codeExamples
}
