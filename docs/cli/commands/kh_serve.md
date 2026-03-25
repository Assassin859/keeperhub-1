## kh serve

Start a server

**Deprecated:** Use the remote MCP endpoint instead:

```
claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp
```

### Synopsis

Start a KeeperHub server process.

Currently only MCP stdio mode is supported. When started with --mcp, the
server speaks the Model Context Protocol over stdin/stdout and registers
tools dynamically from the /api/mcp/schemas endpoint at startup.

All diagnostic output (warnings, errors) is written to stderr. Only
valid JSON-RPC 2.0 messages appear on stdout.

```
kh serve [flags]
```

### Examples

```
  # Start an MCP stdio server (for use with Claude, Cursor, etc.)
  kh serve --mcp
```

### Options

```
  -h, --help   help for serve
      --mcp    Start MCP stdio server
```

### Options inherited from parent commands

```
  -H, --host string   KeeperHub host (default: app.keeperhub.com)
      --jq string     Filter JSON output with a jq expression
      --json          Output as JSON
      --no-color      Disable color output
  -y, --yes           Skip confirmation prompts
```

### SEE ALSO

* [kh](kh.md)	 - KeeperHub CLI
