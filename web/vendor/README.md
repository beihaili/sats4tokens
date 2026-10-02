# Vendored browser libraries

Loaded lazily by `web/checkout.js` the first time the camera is opened on the 🥜 Cashu tab.

| File | What | License |
|---|---|---|
| `jsQR.js` | [jsQR](https://github.com/cozmo/jsQR) 1.4.0 `dist/jsQR.js`, QR decoder for browsers without `BarcodeDetector` (Safari, Firefox) | Apache-2.0 (`jsQR.LICENSE`) |
| `bcur.js` | NUT-16 animated QR (`ur:bytes/…`) decoder: [@gandlaf21/bc-ur](https://github.com/gandlafbtc/bc-ur) 1.1.12, the library cashu.me uses, bundled with its deps | MIT; deps MIT / BSD-3 / Apache-2.0 (all texts in `bcur.LICENSE`) |

`bcur.js` is built from `bcur-src/`. Build it in a scratch directory (`web/` is served as-is, so no `node_modules` here):

```sh
npm i @gandlaf21/bc-ur@1.1.12 esbuild
npx esbuild bcur-src/entry.js --bundle --minify --format=iife --global-name=BCUR --platform=browser \
  --define:global=globalThis --alias:@apocentre/alias-sampling=./bcur-src/sampler.js --outfile=bcur.js
```

bc-ur depends on `@apocentre/alias-sampling`, which is GPL-2.0. `bcur-src/sampler.js` replaces it with our own
Walker–Vose sampler. It was checked against the original: 200k draws, identical output. That matters because the
decoder must pick the same fragments the wallet's encoder picked. An encoder→decoder round trip that starts mid-animation
and drops half the frames decodes in 10–18 frames.
