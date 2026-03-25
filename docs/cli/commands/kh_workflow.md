## kh workflow

Manage workflows

### Examples

```
  # List workflows
  kh wf ls

  # Run a workflow
  kh wf run abc123
```

### Options

```
  -h, --help        help for workflow
      --jq string   Filter JSON output with a jq expression
      --json        Output as JSON
```

### Options inherited from parent commands

```
  -H, --host string   KeeperHub host (default: app.keeperhub.com)
      --no-color      Disable color output
  -y, --yes           Skip confirmation prompts
```

### SEE ALSO

* [kh](kh.md)	 - KeeperHub CLI
* [kh workflow delete](kh_workflow_delete.md)	 - Delete a workflow
* [kh workflow get](kh_workflow_get.md)	 - Get a workflow
* [kh workflow go-live](kh_workflow_go-live.md)	 - Publish a workflow
* [kh workflow list](kh_workflow_list.md)	 - List workflows
* [kh workflow pause](kh_workflow_pause.md)	 - Pause a workflow
* [kh workflow run](kh_workflow_run.md)	 - Run a workflow

