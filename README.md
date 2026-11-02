# 🔒 pdf util

> Built with **SvelteKit + TypeScript** — runs entirely in the browser, no backend.

I built this because I wasn't comfortable uploading sensitive documents — passports, bank statements — to third-party servers.

Everything runs in your browser. Nothing is sent to a server. Works in airplane mode.

🌐 **Live at [pdf.salveendutt.com](https://pdf.salveendutt.com)**

![pdf util](assets/frontpage.png)

## Tech stack

**SvelteKit + TypeScript**. PDF processing is done entirely client-side using [pdf-lib](https://pdf-lib.js.org/) — no backend, no server, no file uploads.

## Run locally

```bash
git clone https://github.com/salveen/pdf-util.git
cd pdf-util
npm install
npm run dev
```

Then open `http://localhost:5173` in your browser.

## Build & preview

```bash
npm run build
npm run preview
```

## Test

```bash
npm test
```

Runs the unit tests with Node's built-in test runner (Node 22.18 or newer, which reads TypeScript directly); no extra packages needed.
