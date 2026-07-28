## kh workflow pause

Pause a workflow

```
kh workflow pause <workflow-id> [flags]
```

### Examples

```
  # Pause a workflow (will prompt for confirmation)
  kh wf pause abc123

  # Pause without prompting
  kh wf pause abc123 --yes
```

### Options

```
  -h, --help   help for pause
  -y, --yes    Skip confirmation prompt
```

### Options inherited from parent commands

```
  -H, --host string   KeeperHub host (default: app.keeperhub.com)
      --jq string     Filter JSON output with a jq expression
      --json          Output as JSON
      --no-color      Disable color output
      --org string    Organization ID to use (overrides default from auth)
```

### SEE ALSO

* [kh workflow](kh_workflow.md)	 - Manage workflows

