# Install and run the dashboard — no experience needed

This guide assumes you have never used a terminal and have never installed
Python. Follow your operating system's track from top to bottom; every
command says where to type it and what you should see. If anything goes
wrong, there's a [troubleshooting table](#something-went-wrong) at the end.

What you'll end up with: the dashboard running in your web browser at
`http://localhost:8872`, showing a year of real GB power market data that
your own computer fetched from public sources. Nothing here needs an
account, an API key or a paid service.

Time required: about 15 minutes, most of it waiting for the first data
build (3–5 minutes of automatic downloading).

---

## Before either track: get the project folder

1. Go to `https://github.com/lptva/gb-power-dashboard` in your browser.
2. Click the green **Code** button, then **Download ZIP**.
3. Find the downloaded file (usually in your **Downloads** folder) and
   double-click it to extract. You get a folder called
   **`gb-power-dashboard-main`**.
4. Move that folder somewhere permanent — your **Documents** folder is
   fine. The market data will live inside it, so don't leave it in
   Downloads where you might delete it later.

(If you already use `git`: `git clone
https://github.com/lptva/gb-power-dashboard` does the same job, and your
folder is called `gb-power-dashboard` instead — adjust the `cd` commands
below to match.)

---

## Mac track

### 1. Open Terminal

Press **⌘ + Space** (Command and Space together), type `terminal`, press
**Return**. A window appears with a line of text ending in `%` or `$` —
that's the *prompt*, where you type commands. After each command below,
press **Return** to run it.

### 2. Check whether you already have Python

Type this at the prompt:

```
python3 --version
```

- If you see `Python 3.10` or higher (e.g. `Python 3.12.4`): skip to
  step 4.
- If you see `Python 3.9` or lower, `command not found`, **or a pop-up
  appears offering to install "command line developer tools"**: click
  **Cancel** on the pop-up (you don't need those — they're a large
  download for software developers) and do step 3.

### 3. Install Python (only if step 2 said so)

1. In your browser, go to `https://www.python.org/downloads/`.
2. Click the yellow **Download Python 3.x.x** button (whatever version it
   offers — anything from 3.10 up is fine).
3. Open the downloaded `.pkg` file and click **Continue / Agree /
   Install** through the installer. It may ask for your Mac password —
   that's normal for any installation.
4. Close and reopen Terminal (important — the old window doesn't know
   about the new Python), then repeat step 2. You should now see a
   version number.

### 4. Go to the project folder

If you put the folder in Documents:

```
cd ~/Documents/gb-power-dashboard-main
```

(`cd` means "change directory". If you put it somewhere else, replace the
path. Tip: type `cd `, then drag the folder from Finder onto the Terminal
window — it fills in the path for you.)

### 5. Set up a private Python workspace for the project

Two commands, run one at a time:

```
python3 -m venv .venv
```

```
.venv/bin/pip install certifi
```

The first creates a folder called `.venv` inside the project — a private
copy of Python so this project can't interfere with anything else on your
Mac. The second installs `certifi` (security certificates for talking to
the data sources) into it. You should see `Successfully installed
certifi-...` at the end.

### 6. Build the dataset

```
.venv/bin/python etl/build_dataset.py --days 365
```

This fetches a year of half-hourly market data from the public sources
(about 160 small downloads). It takes **3–5 minutes** and prints progress
as it goes — lines about chunks and dates scrolling past is exactly what
success looks like. It's finished when you see a line starting with
`Wrote` mentioning `series_hh.json`, and get your prompt back.

### 7. Start the dashboard

```
.venv/bin/python -m http.server 8872 --directory app
```

You should see `Serving HTTP on :: port 8872`. The prompt does **not**
come back — that means the server is running. Leave this window open.

### 8. Open it

In your browser, go to:

```
http://localhost:8872
```

You'll see "Loading market data…" for a moment, then the dashboard. Done.

To stop the server later: click on the Terminal window and press
**Ctrl + C**. To start it again another day: repeat steps 4 and 7 (nothing
needs reinstalling — and if you closed the window, there's no state to
restore; just `cd` back and run the command).

---

## Windows track

### 1. Install Python

1. In your browser, go to `https://www.python.org/downloads/`.
2. Click the yellow **Download Python 3.x.x** button.
3. Run the downloaded installer. **On the very first screen, tick the box
   that says "Add python.exe to PATH"** — this is the one step people
   miss, and nothing works without it. Then click **Install Now**.
4. Close the installer when it says setup was successful.

(Already have Python? Open PowerShell — next step — and type
`py --version`. Anything from `Python 3.10` up is fine and you can skip
the install.)

### 2. Open PowerShell

Press the **Windows key**, type `powershell`, press **Enter**. A blue or
black window appears with a line ending in `>` — that's the *prompt*,
where you type commands. After each command below, press **Enter** to run
it.

### 3. Go to the project folder

If you put the folder in Documents:

```
cd $HOME\Documents\gb-power-dashboard-main
```

(If you put it somewhere else, replace the path. Tip: you can copy the
path from File Explorer's address bar and paste it after `cd `.)

### 4. Set up a private Python workspace for the project

Two commands, run one at a time:

```
py -m venv .venv
```

```
.venv\Scripts\python -m pip install certifi
```

The first creates a folder called `.venv` inside the project — a private
copy of Python just for this project. The second installs `certifi`
(security certificates for talking to the data sources) into it. You
should see `Successfully installed certifi-...` at the end.

### 5. Build the dataset

```
.venv\Scripts\python etl\build_dataset.py --days 365
```

This fetches a year of half-hourly market data from the public sources
(about 160 small downloads). It takes **3–5 minutes** and prints progress
as it goes — scrolling lines about chunks and dates is what success looks
like. It's finished when you see a line starting with `Wrote` mentioning
`series_hh.json`, and get your prompt back.

### 6. Start the dashboard

```
.venv\Scripts\python -m http.server 8872 --directory app
```

You should see `Serving HTTP on :: port 8872`. The prompt does **not**
come back — that means the server is running. Leave this window open.

### 7. Open it

In your browser, go to:

```
http://localhost:8872
```

You'll see "Loading market data…" for a moment, then the dashboard. Done.

To stop the server later: click on the PowerShell window and press
**Ctrl + C**. To start it again another day: repeat steps 3 and 6 (nothing
needs reinstalling).

---

## Something went wrong

| What you see | What it means | Fix |
|---|---|---|
| `command not found: python3` (Mac) or `'py' is not recognized` (Windows) | Python isn't installed, or the terminal window is older than the installation | Do the install step for your track, then **close and reopen** the terminal window and try again. On Windows, re-run the installer and make sure "Add python.exe to PATH" was ticked. |
| A macOS pop-up offering "command line developer tools" | macOS trying to install a large developer package you don't need | Click Cancel and install Python from python.org instead (Mac track, step 3). |
| `CERTIFICATE_VERIFY_FAILED` or another SSL error during the build | Python can't verify the data sources' security certificates | Make sure step "install certifi" succeeded, and that you're running the build with `.venv/bin/python` (Mac) or `.venv\Scripts\python` (Windows), not plain `python3`/`py`. |
| `Address already in use` when starting the server | Something else on your computer is using port 8872 | Use a different number: replace `8872` with `8000` in the server command, and open `http://localhost:8000` instead. |
| A blank page or "Data failed to load" in the browser | The page was opened as a file, or the dataset hasn't been built | Make sure you opened `http://localhost:8872` (not by double-clicking `index.html`), the server window is still open, and the build step finished with a `Wrote ...` line. |
| `running scripts is disabled on this system` (Windows) | PowerShell's policy blocks an "activation" script — none of the commands in this guide need it | Use the commands exactly as written here (they call `.venv\Scripts\python` directly). If you were following some other guide's `activate` step, you can skip it entirely. |
| The build seems stuck | The first build downloads ~160 chunks and can sit quietly for a few seconds between them | Give it the full 5 minutes. If it truly stops, press Ctrl + C and run the same command again — already-downloaded chunks are cached, so it resumes quickly. |

---

## Optional extras (all off by default, none needed for the dashboard)

- **Daily automatic refresh** (Mac): `bash ops/install_schedule.sh` sets
  up a 07:00 job — see [ops/README.md](../ops/README.md) for details and
  how to remove it.
- **European zones**: the dashboard ships with data for seven European
  markets. Viewing them needs nothing; *refreshing* them needs a free
  ENTSO-E API token — see `.env.example` in the project folder.
- **AI overnight summary**: an optional panel, off unless you connect it —
  see the README's "AI summary" section for what it needs and costs.
