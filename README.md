# PsychPlotter

A lightweight, browser-based **psychrometric chart** tool. Plot air states on a
psychrometric chart, switch instantly between **IP and SI** units, and read the
full set of derived properties for each point.

It runs entirely in your browser as a static web page — **no server, no accounts,
no database, and no data ever leaves your machine.**

> **Status:** Proof of concept. Point plotting is implemented; processes and data
> import are on the roadmap below.

## What it does today

- **Plot state points** — enter dry-bulb temperature plus **one** other property
  (relative humidity, wet-bulb, or dew-point) and every remaining property is
  calculated automatically.
- **Processes** — connect points into a process (a line, a multi-point string, a
  branch, or a closed cycle) by referencing existing points, so each state is
  defined and labelled only once. Each segment can be drawn **straight** or
  traced **along the saturation curve, a constant wet-bulb line, or a constant
  enthalpy line** for cooling-below-dew-point and evaporative processes.
- **IP ⇄ SI toggle** — switch unit systems at any time; plotted points keep their
  physical state and all values re-express in the new units.
- **Elevation _or_ pressure** — defaults to sea level; edit either field and the
  other updates via the standard atmosphere.
- **Configurable chart** — toggle the dry-bulb axis, humidity-ratio axis, RH,
  wet-bulb, enthalpy, and dew-point lines, and a background grid, on or off.
- **EPW weather import** — load an EnergyPlus Weather file and plot its 8,760
  hourly conditions on the chart as a density cloud. Parsed entirely in the
  browser; the file is never uploaded.
- **Chart export** — save the chart as a **PNG** or **PDF** image (works on any tab).
- **Save / load projects** — export your points and processes to a small JSON
  file and re-import it later or share it. Kept as a portable file, not the cloud.
- **Light / dark themes.**
- **Property table** — dry-bulb, wet-bulb, dew-point, RH, humidity ratio,
  enthalpy, and specific volume for each point.
- **On-device autosave** — your points and preferences are remembered in the
  browser between visits (via `localStorage`), never transmitted anywhere.

## Roadmap (planned)

- **Process heat breakdown** — per-segment sensible / latent / total heat and
  sensible heat ratio (SHR).
- **CSV import** — plot bulk data from arbitrary CSV files (column mapping).
- **Overlays** — comfort zones and other reference regions.

## Running it

It's a static site — no build step.

**Locally:** clone the repo and open `index.html`, or serve the folder:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

**Hosted:** any static host works (e.g. GitHub Pages).

## Privacy & IT notes

- 100% client-side. No backend, no telemetry, no third-party network calls.
- Holds no personal data. The only storage is your own browser's `localStorage`,
  which stays on your device and can be cleared with **Clear all**.
- The entire tool is plain HTML/CSS/JavaScript with a single vendored,
  permissively licensed calculation library — nothing is fetched at runtime.

## Attribution

Psychrometric calculations use [PsychroLib](https://github.com/psychrometrics/psychrolib)
(MIT License), which implements the formulae from the *2017 ASHRAE Handbook —
Fundamentals* in both IP and SI units. A copy is vendored at
[`js/psychrolib.js`](js/psychrolib.js) with its original license header intact.

## License

MIT — see [LICENSE](LICENSE).
