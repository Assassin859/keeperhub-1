## kh workflow resume

Resume a paused workflow

```
kh workflow resume <workflow-id> [flags]
```

### Examples

```
  # Resume a workflow (will prompt for confirmation)
  kh wf resume abc123

  # Resume without prompting
  kh wf resume abc123 --yes
```

### Options

```
  -h, --help   help for resume
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

