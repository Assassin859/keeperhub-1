# Installing KeeperHub on your own Kubernetes cluster

Start: a Kubernetes cluster and nothing else. Finish: a working install you have
signed into.

About an hour, most of it waiting for one image build.

This guide names specific tools only as examples, in the places where you may not
already have something. Where you do, use yours. What the install actually needs
is listed as capabilities in step 2, and nothing here assumes a particular cloud,
registry, ingress controller or certificate authority.

---

## 1. Before you start

**Tools.** Each should print a version:

```bash
kubectl version --client   # already pointed at your cluster
helm version               # v3
docker buildx version
git --version
envsubst --version         # from gettext
```

**A container registry** your cluster can pull from, and which you can push to.
Any OCI registry works: a cloud provider's, a self-hosted one, or a public one.

Log in to it, then confirm *which identity* you are logged in as. This catches a
trap that otherwise only shows up as `denied` after a long build:

```bash
docker login <your-registry>

# Confirm the identity actually cached for that registry
python3 -c "import json,os,base64; d=json.load(open(os.path.expanduser('~/.docker/config.json'))); \
print({k: base64.b64decode(v['auth']).decode().split(':')[0] for k,v in d.get('auths',{}).items() if v.get('auth')})"
```

If the registry is private, your cluster also needs a pull secret. Create one and
name it per component with `<component>.imagePullSecrets`.

**A domain you control**, for example `app.yourcompany.com`. Not optional: the
app is served on it, and any mail or identity provider you use will verify you
own it.

**A mail relay.** Signup sends a six-digit code, so without one nobody can create
an account. The app speaks SendGrid's v3 `mail/send` request shape; any relay
that accepts that shape works, and `SENDGRID_API_URL` points at it. That is a
protocol requirement, not a vendor one.

Optional, each switchable off and each independent of the others: a wallet
signing service for on-chain writes, a chain RPC provider, a captcha provider,
and an OAuth identity provider for social sign-in. `.env.example` says what each
one unlocks.

---

## 2. Prepare the cluster

Four capabilities. If your cluster already provides one, skip it — the commands
below are one way to get each, not the required way.

**a) A default StorageClass.** Most clusters have one.

```bash
kubectl get storageclass
```

**b) An ingress controller.** Any will do; you name its class in `.env`.

```bash
kubectl get ingressclass          # do you already have one?

# If not, one option:
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace
```

**c) TLS — pick one.**

*Let the chart request certificates.* It emits a cert-manager `Certificate`
referencing a `ClusterIssuer`, so this route needs cert-manager and an issuer.
Set `TLS_ISSUER` in `.env` to the issuer's name.

```bash
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set crds.enabled=true
```

Then create a `ClusterIssuer` for whichever CA you use. An ACME issuer suits a
publicly resolvable domain; a private CA or a self-signed issuer suits an
internal one.

*Or terminate TLS somewhere else*, at a load balancer or service mesh. Then skip
cert-manager entirely, leave `TLS_ISSUER` empty, and pass
`--set app.service.tls.enabled=false` when you install. Nothing else changes.

**d) A database.**

*Chart-managed* (`DB_MODE=bundled`) runs PostgreSQL for you and needs the
CloudNativePG operator installed cluster-wide:

```bash
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.1.yaml
```

*Bring your own* (`DB_MODE=byo`) uses any PostgreSQL you already run. Put its
connection string in a Secret and name it in `.env`.

The queue works the same way: chart-managed by default, or point
`QUEUE_MODE=byo` at any SQS-compatible endpoint you operate.

---

## 3. Fill in your settings

This is the only file you edit. Everything after this reads from it.

```bash
git clone https://github.com/KeeperHub/keeperhub.git
cd keeperhub/deploy/keeperhub-stack/self-hosted

cp .env.example .env
```

Open `.env` and work through it. It is in three parts:

- **REQUIRED** - the install will not work without these.
- **REQUIRED AT BUILD TIME** - compiled into the image. Any may be left empty,
  and empty switches that feature off cleanly. Getting one *wrong* means
  rebuilding, which is why they are decided before you build.
- **OPTIONAL** - each unlocks one area. Leave empty to leave it off.

Two notes while you are in there. Keep the quotes around values, because the
build reads this file with the shell. And if you are going to set
`CHAIN_RPC_CONFIG` at all, set it now: it is read when the database is first
seeded, so a value added later leaves the Block and Event triggers connected to
nothing.

`.env` is gitignored. Do not commit it.

---

## 4. Build the images

From the repository root:

```bash
cd ../../..                                  # back to the repo root
set -a; . deploy/keeperhub-stack/self-hosted/.env; set +a
export IMAGE_TAG=v1

docker buildx bake \
  -f docker-bake.hcl \
  -f deploy/keeperhub-stack/self-hosted/docker-bake.hcl \
  --set "*.cache-from=" --set "*.cache-to=" \
  --push keeperhub
```

Copy that command as it stands. Both `-f` files and both `--set` flags are load
bearing:

- Naming the files stops bake also discovering `docker-compose.yml`, which
  expects a different `.env` and fails a fresh clone with
  `env file .env not found`.
- The `--set` flags drop a build cache the file exports to a registry you do not
  have. Without them Docker's default builder stops with
  `Cache export is not supported for the docker driver`.

That produces eight images in the repository you named, each under its own tag
prefix: `app-`, `migrator-`, `workflow-runner-`, `executor-`, `schedule-`,
`block-`, `collector-`, `sandbox-`.

---

## 5. Install

```bash
cd deploy/keeperhub-stack/self-hosted
ENV_FILE=.env IMAGE_TAG=v1 ./install.sh
```

It checks the prerequisites first and stops with a message naming anything
missing. Watch it come up:

```bash
kubectl -n keeperhub get pods -w
```

---

## 6. Point your domain at it, and sign in

```bash
kubectl -n keeperhub get ingress
```

Point your `APP_HOST` at that address however your DNS works, then:

```bash
curl https://app.yourcompany.com/api/health
# {"status":"ok","timestamp":"..."}
```

Open the site, choose **Create an account**, and enter the six-digit code from
your inbox. You will set up two-factor authentication, then name your
organisation. That is the whole thing.

---

## If something looks wrong

These fail quietly, leaving every pod green.

| Symptom | Cause |
| --- | --- |
| `denied` when pushing images | logged in to that registry as a different identity than you expect. Check the identity, not just that a login exists |
| Signup form renders, then "Missing CAPTCHA response" | the captcha site key was wrong at build time. Rebuild, or set `TURNSTILE_DISABLED=true` |
| The six-digit code never arrives | no working mail relay, or a From address the relay has not verified |
| The UI loads and reads, but every save returns 403 | `APP_HOST` does not match the hostname you are using |
| Block or Event triggers never fire | `CHAIN_RPC_CONFIG` was set after installing, or a chain key is misspelled. The keys are exact: Ethereum's testnet is `eth-sepolia`, Base's is `base-testnet` |
| A sign-in button appears but the flow fails | a client id is set and its secret is not, or the reverse |

---

## Optional: lock down outbound traffic

Once it works, deny all egress except what the product needs:

```bash
EGRESS_POLICY=true ENV_FILE=.env IMAGE_TAG=v1 ./install.sh
```

This blocks your private network, your nodes and any cloud metadata service,
while allowing DNS and the public internet. It only takes effect if your CNI
enforces NetworkPolicy; several do not, and the installer tells you which case
you are in.

---

## Where to look next

- `README.md` beside this file - every setting explained
- `DEPENDENCIES.md` - every host the product contacts, and how to switch each
  one off
