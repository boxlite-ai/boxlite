# ascii-magic-art (vendored)

The animated ASCII art library from https://www.ascii-magic.com/ascii (npm `ascii-magic-art` 1.0.2,
MIT, see LICENSE), self-hosted so the console's sign-in page loads nothing from a third-party origin.
Only the player runtime, its drawing kit and the pieces the console uses are kept; add a piece by
copying `pieces/<name>.js` from the package. Served at `/console/vendor/ascii-magic-art/` (routes/console/static.ts).
