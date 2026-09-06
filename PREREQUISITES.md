# Prerequisites

## Required software

- **Node.js 18 LTS or newer** (the `package.json` `engines` field says
  `>=16`, but Puppeteer 24.x and its bundled Chromium build work more
  reliably on 18+; 16 is past end-of-life upstream).
- **npm** (ships with Node) or **yarn**, whichever you prefer — this repo's
  `yarn.lock` suggests yarn, but `npm install` works fine too.
- **git**, to clone the repo.
- A working **GUI display** for the login step. Login is *interactive and
  headful* — Puppeteer opens a real, visible Chrome window so you can type
  the 6-digit email code yourself. On:
  - **Native Linux desktop** — works out of the box.
  - **WSL2** — requires **WSLg** (bundled with recent Windows 11 WSL
    updates) so a Linux GUI window can render on your Windows desktop. Check
    with `echo $DISPLAY` — if it's empty, WSLg isn't active and no browser
    window will appear.
  - **Headless server / SSH-only box** — not supported as-is; you'd need
    a VNC/X11-forwarding setup, which is outside this project's scope.

## System libraries (Debian/Ubuntu, including WSL2 Ubuntu)

Puppeteer bundles its own Chromium binary, but that binary still depends on
shared libraries that aren't installed by default on a minimal Ubuntu image:

```bash
sudo apt-get update
sudo apt-get install -y \
  libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 \
  libxss1 libxshmfence1 libx11-xcb1 fonts-liberation
```

If the browser window fails to open or crashes immediately, this is the
first thing to check — Puppeteer's error messages for missing shared
libraries are notoriously unhelpful.

## Disk space

Export sizes vary enormously by conversation length and whether attachments
are embedded — some threads in real-world use have produced single JSON
files well over 100MB. Make sure your output directory has generous free
space (several GB is a safe minimum for a large, long-running library) and
isn't on a network-mounted or size-constrained volume.

## Installation

Run `install.sh` from the repo root, or do it manually:

```bash
git clone https://github.com/patk1002/perplexport.git
cd perplexport
npm install
npm run build
```

Then run it:

```bash
node dist/cli.js -e <your-email> -o ./conversations -d done.json
```