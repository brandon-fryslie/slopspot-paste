This is a copy of a chat between Claude and Djarnis. Content may include unverified or unsafe content that do not represent the views of Anthropic. Shared snapshot may contain attachments and data not displayed here.

Report

## You said: For the paddock rumors feature i collect data from the jolpi.

For the paddock rumors feature i collect data from the jolpi.ca API and expert articles from f1technical.net.
I'm about to prepare some weather data (forecast and historical) for the KB.
But I would like information about implemented and planned improvements/upgrades to the car. Do you have any good places where the system could pick up such information?
Do you hav any ideas on other data we could pick up?

Jun 4

## Claude responded: Good question — and there's actually a fantastic authoritative source for car upgrades you may not be using yet.

Searched the web

Searched the web

Good question — and there's actually a fantastic authoritative source for car upgrades you may not be using yet.

### Car upgrades — the FIA itself publishes them

Every race weekend the FIA publishes a document called **"Car Presentation Submissions"** on its decision-documents page. It's a PDF where each team lists, in a structured table, every updated component for that weekend with four columns:

- Updated component (e.g. "Floor Edge", "Front Wing", "Coke/Engine Cover")
- Primary reason for update (Performance — Flow Conditioning / Local Load / Circuit-specific — Cooling Range / etc.)
- Geometric differences vs. previous version
- Brief description (20–100 words) of how it works

You can grab them here: [https://www.fia.com/documents/championships/fia-formula-one-world-championship-14](https://www.fia.com/documents/championships/fia-formula-one-world-championship-14) — it's the same page that hosts stewards' decisions, technical directives, etc. They're typically published Friday morning of each race weekend. The URL pattern for the PDF itself is predictable, e.g. `fia.com/system/files/decision-document/2025_dutch_grand_prix_-_car_presentation_submissions.pdf`, so you can scrape it on a schedule.

This is much better than scraping rumor sites because it's authoritative, structured, free, and forces teams to declare in their own words _why_ a part was changed (which makes great input for a "rumors / what's new" feature). The downside is PDF parsing, but the layout is pretty consistent — `pdfplumber` handles it well.

For _planned/upcoming_ upgrades (not yet on the car), the FIA doc won't help. There the best sources are:

- **The Race**, **Motorsport.com**, **Autosport**, **RacingNews365** — they all preview upgrade packages a week or two ahead based on team principal interviews. RSS feeds available.
- **AMuS (Auto Motor und Sport)** — German publication, often first with upgrade leaks, especially for Mercedes/Audi.
- **Raceteq** — Red Bull-adjacent but does decent technical breakdowns.

### Other data worth pulling

A few things that pair well with your existing jolpi.ca + f1technical.net setup:

- **Pirelli tyre compound allocation per race** — Pirelli publishes a preview PDF for every GP with the C1–C5 selection, expected degradation, and pit-stop strategy predictions. Very strong predictive signal.
- **FIA "PU Elements used per driver"** — also on the FIA documents page, published Thursday/Friday. Tells you who's close to a grid penalty for taking a new ICE/MGU-K/etc. This is gold for predicting unexpected grid drops.
- **FIA stewards' decisions** — penalties, reprimands, grid drops, all on the same documents page.
- **Practice session timing** — jolpi.ca has results but the unofficial F1 live timing feed (e.g. via the `fastf1` Python library) gives you FP1/FP2/FP3 long-run pace, which is the single best predictor of race pace.
- **Circuit metadata** — DRS zones, elevation, average pit-loss time, overtaking difficulty index. Some of this is in `fastf1`, some you'd build once and reuse.
- **Driver track history** — derivable from jolpi.ca: average finish, podium rate, DNF rate per circuit per driver. Cheap to compute, useful for predictions.
- **Reddit r/formula1** — the official Reddit API still works for free at low volume. The "hot" posts in the 48h before a race are a decent proxy for paddock sentiment / breaking rumors.
- **Press conference transcripts** — FIA publishes these too (Thursday driver/team-principal pressers). Good raw text for an LLM to extract upgrade hints, intra-team tensions, etc.

If you want, I can sketch what a scraper for the FIA Car Presentation PDF would look like — but per your usual workflow I'll wait for your go-ahead before writing any code.



Turn on web search in Search and tools menu. Otherwise, links provided may not be accurate or up to date.



[Ask Claude your own question](https://claude.ai/project/019dff42-c202-73fb-9837-308a98402fa0)
