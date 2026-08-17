# Printable Tiled Road Map PDF

A single-file browser web app that generates multi-page printable OpenStreetMap PDFs centered on an address. Each page is a map section that can be printed and taped together. Road names are kept readable by targeting sufficient zoom and print resolution.

## How to use

1. Open `index.html` in a modern browser (Chrome, Firefox, or Edge recommended).  
   You can double-click the file or serve the folder with any static server:
   ```bash
   python3 -m http.server 8080
   # then visit http://localhost:8080
   ```
2. Enter an address, radius (mi or km), max number of pages, paper size, and orientation.
3. Choose target DPI and minimum street-name zoom (default 16 is a good balance for readable names).
4. Click **Generate PDF**. The app will:
   - Geocode the address (Nominatim)
   - Plan a near-square page grid that fits under your max pages
   - Choose the highest zoom that still covers as much of the requested radius as possible while keeping road names readable
   - Stitch OSM tiles into high-resolution page images
   - Assemble a multi-page PDF with labels, scale bars, north arrows, and registration marks
5. Download the PDF, print at **100% scale** (disable “fit to page” / “shrink to fit”), then tape the pages together using the row/column labels.

## Design choices for readable road names

- Minimum zoom floor (default z16) so street names appear on the tiles.
- Target print DPI (150–250) determines the pixel size of each page.
- Coverage is **clipped** when the requested radius cannot fit inside the page budget at the readable zoom. Readability is prioritized over full-radius coverage.
- Consistent scale across all pages.

## Inputs

| Input | Description |
|-------|-------------|
| Address | Free-text place or street address |
| Radius + unit | Half-side length of the desired square coverage |
| Max pages | Upper limit on PDF pages (grid is chosen to stay ≤ this) |
| Paper / orientation | Letter or A4, portrait or landscape |
| Target DPI | Print resolution target (higher = sharper text, more tiles) |
| Min street-name zoom | Floor for readable labels (15–17) |

## Notes & limitations

- Uses standard OSM raster tiles. They include more than just roads, but at z15–17 roads and their names dominate.
- Respects OSM tile usage policy with modest concurrency and delays. Large jobs (high DPI + many pages + high zoom) take longer and may be rate-limited if overused.
- Nominatim geocoding requires a valid User-Agent (included). Do not hammer the service.
- Best for neighborhood / small-city radii (roughly 0.5–5 mi / 1–8 km) at 4–16 pages. Very large radii will be clipped to keep names readable.
- Projection is a simple local approximation; fine for typical printable map sizes.

## Attribution

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.  
Tiles served by the OpenStreetMap tile servers under their usage policy.
