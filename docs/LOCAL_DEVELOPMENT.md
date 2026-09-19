# Local development

Read AGENTS.md and PRODUCT.md first. The fork follows upstream's core application and checks; the retained integration scope is in ROADMAP.md.

Install Node compatible with the locked Vite release, stable Rust with rustfmt/clippy, and Tauri's platform prerequisites. Run:

```sh
npm ci
npm run check
npm run build
npm run tauri dev
```

On Node versions that expose experimental global Web Storage, run web tests with `NODE_OPTIONS=--no-experimental-webstorage` so the DOM test environment owns localStorage. Do not treat fixture tests as authenticated agent or service acceptance.

A local compile without launching the app is `npm run tauri build -- --debug --no-bundle`. Windows installers use `npm run build:windows` on Windows. Record the exact revision, local changes, tool versions and platform with acceptance evidence.

Keep the fork identifier `com.kaceper11.monocode`, version and updater identity. It owns its app profile and must not migrate another installation's sessions or credentials. Provider CLIs retain their own credential mechanisms; this is not a credential sandbox. Development updater settings remain empty. Release configuration is limited to the assigned fork repository and requires separate publication authority.

Convergence preserves the former fork workspace snapshot once in the existing database before adapting it to upstream layout. Retired feature storage remains untouched. Keep a profile backup before deliberately accepting a migration on real user data; recovery evidence must distinguish saved records from currently supported UI.

Performance requires representative release measurements. Bundle size, debug builds, unit tests and successful packaging are not responsiveness or live Windows/WSL evidence.
