# BoxLite MCP (Model Context Protocol) Server

BoxLite MCP Server allows AI agents to utilize:

- BoxLite Box Management (Create, Destroy)
- Execute commands in BoxLite Boxes
- File Operations in BoxLite boxes
- Generate preview links for web applications running in BoxLite Boxes

## Prerequisites

- BoxLite account
- BoxLite CLI installed
- A compatible AI agent (Claude Desktop App, Claude Code, Cursor, Windsurf)

## Steps to Integrate BoxLite MCP Server with an AI Agent

1. **Install the BoxLite CLI:**

**Mac/Linux**

```bash
brew install boxlite-ai/cli/boxlite
```

**Windows**

```bash
powershell -Command "irm https://get.boxlite.io/windows | iex"
```

2. **Log in to your BoxLite account:**

```bash
boxlite login
```

3. **Initialize the BoxLite MCP server with Claude Desktop/Claude Code/Cursor/Windsurf:**

```bash
boxlite mcp init [claude/cursor/windsurf]
```

4. **Open Agent App**

## Integrating with Other AI Agents Apps

**Run the following command to get a JSON BoxLite MCP configuration which you can c/p to your agent configuration:**

```bash
boxlite mcp config
```

**Command outputs the following:**

```json
{
  "mcpServers": {
    "boxlite-mcp": {
      "command": "boxlite",
      "args": ["mcp", "start"],
      "env": {
        "HOME": "${HOME}",
        "PATH": "${HOME}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
      },
      "logFile": "${HOME}/Library/Logs/boxlite/boxlite-mcp-server.log"
    }
  }
}
```

Note: if you are running BoxLite MCP Server on Windows OS, add the following to the env field of the configuration:

```json
"APPDATA": "${APPDATA}"
```

**Finally, open or restart your AI agent**

## Available Tools

### Box Management

- `create_box`: Create a new box with BoxLite

  - Parameters:
    - `id` (optional): Box ID - if provided, an existing box will be used, new one will be created otherwise
    - `target` (optional): Target region of the box (if not provided, default region of the organization is used)
    - `image`: Image of the box (optional)
    - `auto_stop_interval` (default: "15"): Auto-stop interval in minutes (0 means disabled)
    - `auto_delete_interval` (default: "-1"): Auto-delete interval in minutes (negative value means disabled, 0 means delete immediately upon stopping)

- `destroy_box`: Destroy a box with BoxLite

### File Operations

- `upload_file`: Upload a file to the BoxLite box

  - Files can be text or base64-encoded binary content
  - Creates necessary parent directories automatically
  - Files persist during the session and have appropriate permissions
  - Supports overwrite controls and maintains original files formats
  - Parameters:
    - `id` (optional): Box ID
    - `file_path`: Path to the file to upload
    - `content`: Content of the file to upload
    - `encoding`: Encoding of the file to upload
    - `overwrite`: Overwrite the file if it already exists

- `download_file`: Download a file from the BoxLite box

  - Returns file content as text or base64 encoded image
  - Handles special cases like matplotlib plots stored as JSON
  - Parameters:
    - `id` (optional): Box ID
    - `file_path`: Path to the file to download

- `create_folder`: Create a new folder in the BoxLite box

  - Parameters:
    - `id` (optional): Box ID
    - `folder_path`: Path to the folder to create
    - `mode`: Mode of the folder to create (defaults to 0755)

- `get_file_info`: Get information about a file in the BoxLite box

  - Parameters:
    - `id` (optional): Box ID
    - `file_path`: Path to the file to get information about

- `list_files`: List files in a directory in the BoxLite box

  - Parameters:
    - `id` (optional): Box ID
    - `path`: Path to the directory to list files from (defaults to current directory)

- `move_file`: Move or rename a file in the BoxLite box

  - Parameters:
    - `id` (optional): Box ID
    - `source_path`: Source path of the file to move
    - `dest_path`: Destination path where to move the file

- `delete_file`: Delete a file or directory in the BoxLite box

  - Parameters:
    - `id` (optional): Box ID
    - `file_path`: Path to the file or directory to delete

### Git Operations

- `git_clone`: Clone a Git repository into the BoxLite box

  - Parameters:
    - `id` (optional): Box ID
    - `url`: URL of the Git repository to clone
    - `path`: Directory to clone the repository into (defaults to current directory)
    - `branch`: Branch to clone
    - `commit_id`: Commit ID to clone
    - `username`: Username to clone the repository with
    - `password`: Password to clone the repository with

### Command Execution

- `execute_command`: Execute shell commands in the ephemeral BoxLite Linux environment

  - Returns full stdout and stderr output with exit codes
  - Commands have box user permissions
  - Parameters:
    - `id` (optional): Box ID
    - `command`: Command to execute

### Preview

- `preview_link`: Generate accessible preview URLs for web applications running in the BoxLite box

  - Creates a secure tunnel to expose local ports externally without configuration
  - Validates if a server is actually running on the specified port
  - Provides diagnostic information for troubleshooting
  - Supports custom descriptions and metadata for better organization of multiple services
  - Parameters:
    - `id` (optional): Box ID
    - `port`: Port to expose
    - `description`: Description of the service
    - `check_server`: Check if a server is running

## Troubleshooting

- **Authentication issues:** Run `boxlite login` to refresh your credentials
- **Connection errors:** Ensure that the BoxLite MCP Server is properly configured
- **Box errors:** Check box status with `boxlite box list`

## Support

For more information, visit [boxlite.io](https://boxlite.io) or contact support at <support@boxlite.io>.
