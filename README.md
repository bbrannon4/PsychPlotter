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
- **IP ⇄ SI toggle** — switch unit systems at any time; plotted points keep their
  physical state and all values re-express in the new units.
- **Elevation / barometric pressure** — defaults to sea level; enter any elevation
  and the standard atmospheric pressure updates accordingly.
- **Property table** — dry-bulb, wet-bulb, dew-point, RH, humidity ratio,
  enthalpy, and specific volume for each point.
- **On-device autosave** — your points are remembered in the browser between
  visits (via `localStorage`), never transmitted anywhere.

## Roadmap (planned)

- **Processes** — connect points into heating/cooling/humidification/mixing
  processes with sensible/latent breakdowns.
- **Data import** — plot bulk data from **CSV** and **EPW** (EnergyPlus weather)
  files, parsed locally in the browser (scatter and binned-density views).
- **Project files** — save a project to a small JSON file and re-import it later
  (and to share with a colleague). No cloud storage, no personal data.
- **Overlays** — comfort zones and other reference regions.
- **Chart export** — PNG/PDF of the chart for reports.

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
