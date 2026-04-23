# @keeperhub/sandbox

Standalone HTTP service that evaluates user JavaScript for the KeeperHub Code workflow node. Reuses the original `node:vm` + `child_process` + `\x01RESULT\x02` sentinel wire format verbatim.

## Endpoints

- `GET /healthz` -> `200 ok`
- `POST /run` -> body: base64(v8.serialize({ code, timeout })); response: `\x01RESULT\x02` + base64(v8.serialize(ChildOutcome)) + `\n`

## Env

- `SANDBOX_PORT` (default `8787`)

## Runtime

- Node 24 alpine
- Zero runtime npm deps (Node built-ins only)
- `tini` as PID 1 to reap child processes

## Kubernetes requirement (downstream deploy)

Pod spec MUST set `automountServiceAccountToken: false` and use a dedicated ServiceAccount with no RoleBindings and no `eks.amazonaws.com/role-arn` IRSA annotation. This is enforced at the cluster layer; this image does not include credentials.
