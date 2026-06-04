# AWS Deployment Guide

Replaces the Railway hosting with a single EC2 box running nginx + uvicorn
+ PM2. End state: dashboard reachable on `http://<public-ip>/`.

## Prerequisites

- AWS CLI installed and configured (`aws configure` — region `ap-southeast-2`)
- IAM user `swathi` with at least `AmazonEC2FullAccess` and SSM read on
  `/aws/service/canonical/*`
- A bash shell (Git Bash on Windows works for steps 1–2; steps 3–5 run on
  the EC2 instance itself)
- Roughly 30 minutes of attention

## Files in this directory

| File | Where it runs | Purpose |
|---|---|---|
| `01_create_ec2.sh` | Your laptop | Creates security group, key pair, instance |
| `02_setup_server.sh` | EC2 (as root) | Installs Python 3.11, Node 20, nginx, PM2 |
| `03_deploy_app.sh` | EC2 (as `ubuntu`) | Clones repo, builds frontend, starts backend |
| `nginx.conf` | EC2 (`/etc/nginx/sites-available/moneypenny`) | Reverse-proxy + static serve |
| `.env.example` | EC2 (`/opt/moneypenny/backend/.env`) | Backend env-var template |
| `instance-info.txt` | Your laptop (gitignored) | IP / instance-id record |

## Step 1 — Create the EC2 instance (local)

```bash
cd deploy/aws
chmod +x 01_create_ec2.sh
./01_create_ec2.sh
```

The script prints the public IP and writes `instance-info.txt` next to itself
(gitignored). The private key lands at `~/.ssh/moneypenny-key.pem` with
`chmod 400`.

## Step 2 — Connect to the instance

```bash
ssh -i ~/.ssh/moneypenny-key.pem ubuntu@<PUBLIC_IP>
```

If the first SSH attempt hangs, wait another 30–60 s — EC2 instances finish
initializing after the API says `running`.

## Step 3 — Bootstrap the server (on EC2)

Pull the setup script straight from GitHub so you don't have to scp it:

```bash
wget https://raw.githubusercontent.com/swathimoneypenny/moneypenny_dashboard/main/deploy/aws/02_setup_server.sh
chmod +x 02_setup_server.sh
sudo ./02_setup_server.sh
```

Takes ~3–5 minutes. Installs Python 3.11, Node 20, nginx, PM2 and configures
UFW.

## Step 4 — Deploy the application (on EC2)

```bash
wget https://raw.githubusercontent.com/swathimoneypenny/moneypenny_dashboard/main/deploy/aws/03_deploy_app.sh
chmod +x 03_deploy_app.sh
./03_deploy_app.sh        # NOTE: do NOT sudo — the script sudos where needed
```

This clones the repo to `/opt/moneypenny`, builds the React bundle, starts
uvicorn under PM2, and wires nginx. On first run it copies `.env.example`
to `/opt/moneypenny/backend/.env` and warns you to fill it in.

## Step 5 — Populate environment variables

```bash
sudo nano /opt/moneypenny/backend/.env
# Paste / type every secret from .env.example — at minimum:
#   TIMESHEET_API_KEY, TIMESHEET_API_TOKEN, GROQ_API_KEY,
#   DASHBOARD_PASSWORD, DASHBOARD_SESSION_SECRET
pm2 restart backend
```

Generate `DASHBOARD_SESSION_SECRET` with:

```bash
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

## Step 6 — Open the dashboard

`http://<PUBLIC_IP>/` — log in with `DASHBOARD_PASSWORD`.

## Redeploying after a push to `main`

```bash
ssh -i ~/.ssh/moneypenny-key.pem ubuntu@<PUBLIC_IP>
./03_deploy_app.sh
```

The script is idempotent: it pulls latest, re-installs deps, rebuilds the
frontend, and `pm2 startOrReload`s the backend without dropping connections.

## Troubleshooting

| Symptom | Check |
|---|---|
| Site returns 502 | `pm2 logs backend` — uvicorn probably crashed on missing env var |
| Site returns 404 on `/api/...` | `sudo nginx -t` then `sudo tail /var/log/nginx/error.log` |
| `npm run build` OOMs on t2.micro | Add 2 GB swap: `sudo fallocate -l 2G /swap && sudo chmod 600 /swap && sudo mkswap /swap && sudo swapon /swap` |
| Backend won't restart after `.env` edit | `pm2 restart backend --update-env` |
| Reboot lost the backend | `pm2 startup` was skipped — re-run `03_deploy_app.sh` |

Useful commands:

```bash
pm2 status                    # process state
pm2 logs backend --lines 200  # tail backend logs
pm2 monit                     # live CPU / memory
sudo systemctl reload nginx   # apply nginx config changes
sudo tail -f /var/log/nginx/{access,error}.log
```

## Locking down ports 8000 / 5173 (recommended after first deploy)

The security group opens 8000 and 5173 publicly so you can hit the backend
directly while debugging. Once nginx is the canonical entry point:

```bash
aws ec2 revoke-security-group-ingress \
  --region ap-southeast-2 \
  --group-name moneypenny-dashboard-sg \
  --protocol tcp --port 8000 --cidr 0.0.0.0/0
aws ec2 revoke-security-group-ingress \
  --region ap-southeast-2 \
  --group-name moneypenny-dashboard-sg \
  --protocol tcp --port 5173 --cidr 0.0.0.0/0
```

## Tearing it down

```bash
# Local
INSTANCE_ID=$(grep INSTANCE_ID deploy/aws/instance-info.txt | cut -d= -f2)
aws ec2 terminate-instances --region ap-southeast-2 --instance-ids $INSTANCE_ID
```

The security group and key pair are preserved for the next run; delete them
manually if you're done with the project.
