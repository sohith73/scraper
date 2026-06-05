# How to run the scraper cluster on GCP

Run the FlashFire JR scraper as a **load-balanced cluster of 3 containers** on a
single Google Compute Engine VM, driven entirely by `cluster.sh`.

- One nginx load balancer → 3 scraper replicas (each its own Chromium profile).
- Published on one host port (default `8092`).
- Survives crashes + VM reboots (`restart: always`).

> TL;DR once the VM exists with Docker:
> ```bash
> git clone <repo> && cd .../DASH/scraper
> cp .env.example .env && nano .env      # fill secrets
> ./cluster.sh                           # build + up 3 replicas + LB
> ```

---

## 0. Sizing — pick the VM

Each replica is a full headless Chromium. The compose caps each at **2 GB** and
reserves 512 MB. Plan ~1.5–2 GB + ~1 vCPU per replica, plus headroom for nginx
and the OS.

| Replicas | Recommended machine type | vCPU | RAM   |
|----------|--------------------------|------|-------|
| 3 (default) | `e2-standard-4`       | 4    | 16 GB |
| 5        | `e2-standard-8`          | 8    | 32 GB |
| 1 (test) | `e2-medium`              | 2    | 4 GB  |

Disk: 30 GB+ (the Playwright image is ~2 GB; per-replica Chromium profiles +
run artifacts grow over time). Use a balanced PD.

---

## 1. Create the VM

```bash
gcloud compute instances create flashfire-scraper \
  --project=YOUR_PROJECT \
  --zone=us-central1-a \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB \
  --boot-disk-type=pd-balanced \
  --tags=scraper-lb
```

> Ubuntu 22.04 matches the Playwright base image (`...-jammy`) and Docker's
> `get-docker.sh` path in `docker.sh`.

---

## 2. Open the load-balancer port (firewall)

The cluster publishes **one** port (the LB). Default `8092`. Only the LB port
needs to be reachable — the 3 replicas talk over the internal Docker network and
are never exposed.

**Lock it to your office / dashboard IP** (recommended — the API has debug
routes and no auth by default):

```bash
gcloud compute firewall-rules create allow-scraper-lb \
  --project=YOUR_PROJECT \
  --direction=INGRESS \
  --action=ALLOW \
  --rules=tcp:8092 \
  --target-tags=scraper-lb \
  --source-ranges=YOUR.OFFICE.IP.ADDR/32
```

If the dashboard backend calls the scraper from another GCP VM, add that VM's
internal IP / subnet to `--source-ranges` instead of opening to `0.0.0.0/0`.

---

## 3. SSH in + install Docker

```bash
gcloud compute ssh flashfire-scraper --zone=us-central1-a
```

The repo's `docker.sh` already auto-installs Docker Engine + Compose v2. The
quickest path is to clone first, then let it bootstrap Docker:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <YOUR_REPO_URL> flashfire
cd flashfire/DASH/scraper          # adjust to wherever the scraper lives in your repo

# Installs Docker + Compose if missing, adds you to the docker group:
./docker.sh up || true             # this will install Docker then try a single-container up
```

After Docker installs you may need a fresh shell so the `docker` group applies:

```bash
newgrp docker        # or: exit, then gcloud compute ssh ... again
```

> Don't want the single-container `docker.sh up`? Install Docker manually:
> ```bash
> curl -fsSL https://get.docker.com | sudo sh
> sudo usermod -aG docker $USER && newgrp docker
> ```

---

## 4. Configure secrets — `.env`

```bash
cp .env.example .env
nano .env
```

Fill at minimum:

| Var | What |
|-----|------|
| `OPENAI_API_KEY` | gpt-4o-mini key (intent + relevance filter) |
| `JOBRIGHT_EMAIL` / `JOBRIGHT_PASSWORD` | JR login (auto-login per replica) |
| `DASHBOARD_BASE` | where to push jobs, e.g. `https://hq.flashfirejobs.com` or the dashboard VM's internal URL |
| `DASHBOARD_SERVICE_TOKEN` | if the dashboard requires it |
| `MONGO_URI` / `MONGO_DB` | optional — persists per-client filters |
| `DISCORD_WEBHOOK_URL` | optional ops alerts |
| `PORT` | LB host port (default `8092`) |

> **Gotcha:** Node's `--env-file` truncates at `#`. Any value containing `#`
> (e.g. a password) **must be quoted**: `JOBRIGHT_PASSWORD="Ls..U33Ey#2qhDU"`.

---

## 5. Launch the cluster

```bash
./cluster.sh
```

This builds the image once, spawns **3** scraper containers (each with an
isolated Chromium profile under `cluster/storage-N`), generates the nginx LB,
brings everything up, and waits for each replica to report healthy.

Verify:

```bash
./cluster.sh status
curl -fsS http://localhost:8092/api/health      # a replica answered via the LB
curl -fsS http://localhost:8092/lb-health       # LB itself
```

From your laptop (if firewalled to your IP):

```bash
curl http://EXTERNAL_VM_IP:8092/api/health
```

Get the VM's external IP:
```bash
gcloud compute instances describe flashfire-scraper --zone=us-central1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

---

## 6. Day-2 operations

```bash
./cluster.sh status        # per-replica health + LB probe
./cluster.sh logs          # follow all logs
./cluster.sh logs scraper-2  # one replica
./cluster.sh logs lb         # the load balancer
./cluster.sh ps            # container list
./cluster.sh restart       # restart all
./cluster.sh scale 5       # grow to 5 replicas (regenerates config + up)
./cluster.sh down          # stop + remove the cluster
```

Scaling more replicas needs a bigger VM — see the sizing table. To resize:
`./cluster.sh down`, stop the VM, change machine type, start, `./cluster.sh up`.

---

## 7. Knobs

Set as env vars before any `cluster.sh` command:

```bash
REPLICAS=5 ./cluster.sh up           # 5 replicas instead of 3
LB_PORT=8080 ./cluster.sh up         # publish on host port 8080
LB_METHOD=roundrobin ./cluster.sh up # even spread (only if you don't use live SSE progress)
```

`LB_METHOD` default is `ip_hash` (sticky): an operator's browser pins to one
replica so the run it starts there is the one it polls/streams. Run state + SSE
live in memory per container, so stickiness keeps progress correct.
`roundrobin` spreads more evenly but live SSE can land on a replica that doesn't
own the run.

---

## 8. Keep it running across reboots

`restart: always` keeps containers up across crashes and VM reboots **as long as
the Docker daemon starts on boot** (it does by default on Ubuntu). To be sure:

```bash
sudo systemctl enable docker
```

No systemd unit for the app is needed — Docker restarts the containers itself.
If you want the cluster to also re-`up` after a `down`, just re-run
`./cluster.sh up`.

---

## 9. Notes / caveats

- **Shared JobRight account.** All replicas log into JR with the same
  `JOBRIGHT_EMAIL`/`PASSWORD`. JR may throttle concurrent sessions. True
  multi-account rotation is deferred (see `CLAUDE.md` → "What's NOT here").
- **No built-in auth.** The API (incl. debug routes) is open. Rely on the
  firewall `--source-ranges` to restrict access. Put it behind an HTTPS proxy /
  IAP if exposing publicly.
- **Storage isolation is mandatory.** This is why we don't use
  `docker compose --scale` — two containers on one Chromium profile corrupt it.
  `cluster.sh` gives each replica its own `cluster/storage-N`. Don't point two
  replicas at the same storage dir.
- **First login.** With `JOBRIGHT_EMAIL`/`PASSWORD` set, each replica logs in
  programmatically on first scrape — no headed/X11 step needed on the VM.
- **Cost.** A 24/7 `e2-standard-4` is ~$100–130/mo. Stop the VM when idle:
  `gcloud compute instances stop flashfire-scraper --zone=us-central1-a`.
