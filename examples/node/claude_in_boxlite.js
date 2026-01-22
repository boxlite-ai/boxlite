/**
 * Claude CLI in BoxLite Example - Multi-turn conversation
 *
 * Demonstrates:
 * - Running Claude Code CLI inside a BoxLite VM
 * - Stream-JSON bidirectional communication
 * - Multi-turn conversation with session persistence
 * - Interactive chat mode
 *
 * Prerequisites:
 * 1. BoxLite Node.js SDK built: cd sdks/node && npm run build
 * 2. OAuth token set: export CLAUDE_CODE_OAUTH_TOKEN="your-token"
 *
 * Usage:
 *   npm run claude           # Interactive mode
 *   npm run claude -- --demo # Automated multi-turn test
 */

import { JsBoxlite } from '@boxlite-ai/boxlite';
import * as readline from 'readline';

// Configuration
const BOX_NAME = 'claude-box';
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

// ANSI color codes
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

/**
 * Debug logging helper
 */
function debug(...args) {
  if (DEBUG) {
    console.log('[DEBUG]', ...args);
  }
}

/**
 * Display a Claude message beautifully
 */
function displayMessage(msg, showDebug = false) {
  const msgType = msg.type || 'unknown';
  const c = COLORS;

  if (msgType === 'system') {
    if (showDebug) {
      const subtype = msg.subtype || '';
      console.log(`${c.dim}[system:${subtype}]${c.reset}`);
    }
  } else if (msgType === 'assistant') {
    const message = msg.message || {};
    const contentList = message.content || [];

    for (const content of contentList) {
      const contentType = content.type || '';

      if (contentType === 'text') {
        const text = content.text || '';
        if (text) {
          process.stdout.write(`${c.cyan}${text}${c.reset}`);
        }
      } else if (contentType === 'tool_use') {
        const toolName = content.name || 'unknown';
        const toolInput = content.input || {};

        console.log(`\n${c.yellow}[Tool: ${toolName}]${c.reset}`);

        // Format tool input based on tool type
        if (toolName === 'Write') {
          const filePath = toolInput.file_path || '';
          const contentPreview = (toolInput.content || '').slice(0, 200);
          console.log(`  ${c.dim}Writing to: ${filePath}${c.reset}`);
          if (contentPreview) {
            const lines = contentPreview.split('\n').slice(0, 5);
            for (const line of lines) {
              console.log(`  ${c.dim}| ${line}${c.reset}`);
            }
            if ((toolInput.content || '').length > 200) {
              console.log(`  ${c.dim}| ...${c.reset}`);
            }
          }
        } else if (toolName === 'Bash') {
          const cmd = toolInput.command || '';
          const desc = toolInput.description || '';
          console.log(`  ${c.dim}$ ${cmd}${c.reset}`);
          if (desc) {
            console.log(`  ${c.dim}(${desc})${c.reset}`);
          }
        } else if (toolName === 'Read') {
          const filePath = toolInput.file_path || '';
          console.log(`  ${c.dim}Reading: ${filePath}${c.reset}`);
        } else if (toolName === 'Edit') {
          const filePath = toolInput.file_path || '';
          console.log(`  ${c.dim}Editing: ${filePath}${c.reset}`);
        } else {
          // Generic tool display
          const entries = Object.entries(toolInput).slice(0, 3);
          for (const [key, value] of entries) {
            const valStr = String(value).slice(0, 80);
            console.log(`  ${c.dim}${key}: ${valStr}${c.reset}`);
          }
        }
      }
    }
  } else if (msgType === 'user') {
    // Tool results
    const message = msg.message || {};
    const contentList = message.content || [];

    for (const content of contentList) {
      if (content.type === 'tool_result') {
        const isError = content.is_error || false;
        const resultText = (content.content || '').slice(0, 150);

        if (isError) {
          console.log(`  ${c.red}Error: ${resultText}${c.reset}`);
        } else if (showDebug) {
          console.log(`  ${c.green}OK${c.reset}`);
        }
      }
    }
  } else if (msgType === 'result') {
    const isError = msg.is_error || false;
    const durationMs = msg.duration_ms || 0;
    const cost = msg.total_cost_usd || 0;

    if (isError) {
      const errorMsg = msg.result || 'Unknown error';
      console.log(`\n${c.red}Error: ${errorMsg}${c.reset}`);
    }

    // Show stats
    console.log(
      `${c.dim}[Completed in ${(durationMs / 1000).toFixed(1)}s | Cost: $${cost.toFixed(4)}]${c.reset}`
    );
  }
}

/**
 * Setup Claude box - create new or reuse existing
 */
async function setupClaudeBox(runtime) {
  // Try to get existing box
  let box = await runtime.get(BOX_NAME);

  if (box) {
    console.log(`Found existing ${BOX_NAME}`);

    // Check if Claude is installed
    const checkExecution = await box.exec('which', ['claude'], null, false);
    const checkStdout = await checkExecution.stdout();
    const output = [];

    while (true) {
      const line = await checkStdout.next();
      if (line === null) break;
      output.push(line);
    }

    const checkResult = await checkExecution.wait();

    if (checkResult.exitCode === 0) {
      console.log(`Claude found at: ${output.join('').trim()}`);
      return box;
    }
    console.log('Claude not installed, will install...');
  } else {
    // Create new persistent box
    console.log(`Creating new box: ${BOX_NAME}`);
    box = await runtime.create(
      {
        image: 'node:20-alpine',
        memoryMib: 2048,
        diskSizeGb: 5,
        autoRemove: false, // Persist after exit
        env: [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: OAUTH_TOKEN }],
      },
      BOX_NAME
    );
  }

  // Install Claude CLI
  console.log('Installing Claude CLI (this may take a few minutes)...');
  const installExecution = await box.exec('npm', ['install', '-g', '@anthropic-ai/claude-code'], null, false);
  const installStdout = await installExecution.stdout();

  while (true) {
    const line = await installStdout.next();
    if (line === null) break;
    process.stdout.write(line);
  }

  const installResult = await installExecution.wait();

  if (installResult.exitCode !== 0) {
    throw new Error('Failed to install Claude CLI');
  }

  // Verify installation
  const verifyExecution = await box.exec('claude', ['--version'], null, false);
  const verifyStdout = await verifyExecution.stdout();
  const version = [];

  while (true) {
    const line = await verifyStdout.next();
    if (line === null) break;
    version.push(line);
  }

  await verifyExecution.wait();
  console.log(`Installed: ${version.join('').trim()}`);

  return box;
}

/**
 * Send a message via stream-json and wait for response
 *
 * Note: BoxLite streams stdout in fixed-size chunks (not line-buffered),
 * so we need to buffer data and parse complete JSON lines.
 */
async function sendMessage(stdin, stdout, content, sessionId = 'default', display = true) {
  // Build message
  const msg = {
    type: 'user',
    message: { role: 'user', content },
    session_id: sessionId,
    parent_tool_use_id: null,
  };

  // Send via stdin
  const payload = JSON.stringify(msg) + '\n';
  debug(`Sending message (${payload.length} bytes)`);
  await stdin.writeString(payload);

  // Read response with buffering
  const responses = [];
  let newSessionId = sessionId;
  let buffer = '';

  try {
    while (true) {
      // Read with timeout using Promise.race
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 120000)
      );

      let chunk;
      try {
        chunk = await Promise.race([stdout.next(), timeoutPromise]);
      } catch (err) {
        if (err.message === 'timeout') {
          debug('Read timeout');
          break;
        }
        throw err;
      }

      if (chunk === null) {
        debug('Stream ended (EOF)');
        break;
      }

      // Add to buffer
      buffer += chunk;
      debug(`Buffer size: ${buffer.length} chars`);

      // Process complete lines
      while (buffer.includes('\n')) {
        const newlineIndex = buffer.indexOf('\n');
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) continue;

        try {
          const parsedMsg = JSON.parse(line);
          responses.push(parsedMsg);
          const msgType = parsedMsg.type || 'unknown';
          debug(`Parsed message type=${msgType}`);

          // Display message as it arrives
          if (display) {
            displayMessage(parsedMsg);
          }

          // Capture session_id for multi-turn
          if (parsedMsg.session_id) {
            newSessionId = parsedMsg.session_id;
          }

          // Stop on result message
          if (msgType === 'result') {
            debug('Got result message, stopping read loop');
            throw { stopReading: true };
          }
        } catch (err) {
          if (err.stopReading) throw err;
          debug(`JSON parse error: ${err.message}`);
        }
      }
    }
  } catch (err) {
    if (!err.stopReading) {
      debug(`Read loop ended: ${err.message}`);
    }
  }

  // Extract response from result message
  debug(`Total responses collected: ${responses.length}`);

  const resultMsg = responses.find((r) => r.type === 'result');
  let responseText = '';

  if (resultMsg) {
    responseText = resultMsg.result || '';
  } else {
    // Fallback: try to get text from assistant messages
    for (const r of responses) {
      if (r.type === 'assistant') {
        const contentList = r.message?.content || [];
        for (const c of contentList) {
          if (c.type === 'text' && c.text) {
            responseText = c.text;
            break;
          }
        }
        if (responseText) break;
      }
    }
  }

  return { responseText, sessionId: newSessionId };
}

/**
 * Run interactive session with Claude
 */
async function runInteractiveMode(box) {
  console.log('\n=== Starting Claude Interactive Session ===');
  console.log('Type your messages. Type "quit" to exit.\n');

  // Start Claude in stream-json mode (using box.exec which runs inside VM)
  const claudeExecution = await box.exec(
    'claude',
    ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    [['CLAUDE_CODE_OAUTH_TOKEN', OAUTH_TOKEN]],
    false
  );

  const stdin = await claudeExecution.stdin();
  const stdout = await claudeExecution.stdout();

  let sessionId = 'default';

  // Setup readline for user input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt) =>
    new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });

  try {
    while (true) {
      const userInput = await question('You: ');

      if (!userInput) continue;
      if (['quit', 'exit', 'q'].includes(userInput.toLowerCase())) {
        break;
      }

      console.log(`\n${COLORS.bold}Claude:${COLORS.reset}`);
      const result = await sendMessage(stdin, stdout, userInput, sessionId);
      sessionId = result.sessionId;
      console.log(); // Blank line after response
    }
  } catch (err) {
    if (err.code !== 'ERR_USE_AFTER_CLOSE') {
      console.error('\nError:', err.message);
    }
  } finally {
    rl.close();
    await claudeExecution.wait();
    console.log('Session ended.');
  }
}

/**
 * Run automated multi-turn demo
 */
async function runDemoMode(box) {
  console.log('\n=== Multi-turn Demo ===\n');

  // Start Claude (using box.exec which runs inside VM)
  const claudeExecution = await box.exec(
    'claude',
    [
      '--dangerously-skip-permissions',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ],
    [['CLAUDE_CODE_OAUTH_TOKEN', OAUTH_TOKEN]],
    false
  );

  const stdin = await claudeExecution.stdin();
  const stdout = await claudeExecution.stdout();

  // Turn 1
  console.log(`${COLORS.bold}Turn 1:${COLORS.reset} Remember this number: 42`);
  console.log(`${COLORS.bold}Claude:${COLORS.reset}`);
  const result1 = await sendMessage(stdin, stdout, 'Remember this number: 42. Just say OK.', 'default');
  console.log();

  // Turn 2
  console.log(`${COLORS.bold}Turn 2:${COLORS.reset} What number did I ask you to remember?`);
  console.log(`${COLORS.bold}Claude:${COLORS.reset}`);
  const result2 = await sendMessage(
    stdin,
    stdout,
    'What number did I ask you to remember?',
    result1.sessionId
  );
  console.log();

  // Verify
  const success = result2.responseText.includes('42');
  if (success) {
    console.log(`${COLORS.green}✓ PASS${COLORS.reset} - Claude remembered the number`);
  } else {
    console.log(`${COLORS.red}✗ FAIL${COLORS.reset} - Claude did not remember the number`);
  }

  await claudeExecution.wait();
}

/**
 * Main entry point
 */
async function main() {
  if (!OAUTH_TOKEN) {
    console.error('ERROR: CLAUDE_CODE_OAUTH_TOKEN not set');
    console.error("Run: export CLAUDE_CODE_OAUTH_TOKEN='your-token'");
    process.exit(1);
  }

  // Parse command line args
  const args = process.argv.slice(2);
  const demoMode = args.includes('--demo');

  // Get runtime and setup box
  const runtime = JsBoxlite.withDefaultConfig();
  const box = await setupClaudeBox(runtime);

  if (demoMode) {
    await runDemoMode(box);
  } else {
    await runInteractiveMode(box);
  }

  console.log('\nDone! Box persists for future use.');
}

// Run
main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
