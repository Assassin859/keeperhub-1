# Installing KeeperHub on your own Kubernetes cluster

Start: a Kubernetes cluster and nothing else. Finish: a working install you have
signed into.

About an hour, most of it waiting for one image build.

---

## 1. Before you start

**Tools.** Each of these should print a version:

```bash
kubectl version --client   # already pointed at your cluster
helm version               # v3
docker buildx version
git --version
envsubst --version         # from gettext; apt install gettext-base
```

**A container registry** your cluster can pull from, and you logged into it:

```bash
docker login registry.yourcompany.com
```

There is no public KeeperHub image. Building your own is the normal path.

**A domain you control**, for example `app.yourcompany.com`. Not optional: the
app is served on it, and SendGrid and any OAuth provider verify you own it.

**A mail relay.** Signup sends a six-digit code, so without one nobody can
create an account and the install is unusable. A SendGrid account is the
straightforward choice: authenticate your domain, then create an API key with
Mail Send permission.

Everything else is optional. A Turnkey organisation gives you wallets and
on-chain writes; an Alchemy or Infura key makes chain websockets reliable; a
Cloudflare Turnstile widget gives you a signup captcha.

---

## 2. Prepare the cluster

Four things the chart expects and does not install.

```bash
# a) A default StorageClass. Most clusters have one.
kubectl get storageclass

# b) An ingress controller
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace

# c) cert-manager, for TLS
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set crds.enabled=true

# d) CloudNativePG, which runs your database
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.24/releases/cnpg-1.24.1.yaml
```

Then a cert-manager `ClusterIssuer`. For a public domain:

```bash
kubectl -n cert-manager rollout status deploy/cert-manager-webhook

kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@yourcompany.com
    privateKeySecretRef:
      name: letsencrypt-account
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx
EOF
```

---

## 3. Fill in your settings

This is the only file you edit. Everything after this reads from it.

```bash
git clone https://github.com/KeeperHub/keeperhub.git
cd keeperhub/deploy/keeperhub-stack/self-hosted

cp .env.example .env
```

Open `.env` and work through it. It is in three parts:

- **REQUIRED** - the install will not work without these. Six values: your
  cluster context, your registry, your hostname, your ingress class, your TLS
  issuer, and your mail credentials.
- **REQUIRED AT BUILD TIME** - compiled into the image. Any of them may be
  empty, and empty switches that feature off cleanly. Getting one *wrong* means
  rebuilding, which is why they are decided before you build.
- **OPTIONAL** - each unlocks one area. Leave them empty to leave it off.

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
  --push keeperhub
```

That produces eight images in the repository you named, each under its own tag
prefix:

```
registry.yourcompany.com/keeperhub:app-v1
                                   :migrator-v1
                                   :workflow-runner-v1
                                   :executor-v1
                                   :schedule-v1
                                   :block-v1
                                   :collector-v1
                                   :sandbox-v1
```

Both `-f` files are needed. Naming them also stops bake discovering
`docker-compose.yml`, which expects a different `.env` and fails a fresh clone
with `env file .env not found`.

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

Create a DNS A record for your `APP_HOST` pointing at that address, then:

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
| Signup form renders, then "Missing CAPTCHA response" | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` wrong at build time. Rebuild, or set `TURNSTILE_DISABLED=true` |
| The six-digit code never arrives | No working mail relay, or a From address not verified in that account |
| The UI loads and reads, but every save returns 403 | `APP_HOST` does not match the hostname you are using |
| Block or Event triggers never fire | `CHAIN_RPC_CONFIG` was set after installing, or a chain key is misspelled. The keys are exact: Ethereum's testnet is `eth-sepolia`, Base's is `base-testnet` |
| A sign-in button appears but the flow fails | The client id is set but its secret is not, or the reverse |

---

## Optional: lock down outbound traffic

Once it works, deny all egress except what the product needs:

```bash
EGRESS_POLICY=true ENV_FILE=.env IMAGE_TAG=v1 ./install.sh
```

This blocks your private network, your nodes and the cloud metadata service,
while allowing DNS and the public internet. It only takes effect if your CNI
enforces NetworkPolicy. Calico and Cilium do, several defaults do not, and the
installer tells you which case you are in.

---

## Where to look next

- `README.md` beside this file - every setting explained
- `DEPENDENCIES.md` - every host the product contacts, and how to switch each
  one off
