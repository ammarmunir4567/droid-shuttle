# Contributing to Droid Shuttle

Thank you for helping. This page explains how to propose a change so it can be reviewed and merged quickly.

## Before you start

- **Read the scope.** Droid Shuttle manages an Android phone from a Mac over **ADB**, and installs nothing on the phone. Ideas that need an app on the phone (contacts, messages, call logs) are out of scope. See [Architecture](docs/architecture.md#design-decisions) for why.
- **Open an issue first** for anything bigger than a small fix, so we can agree on the approach before you spend time on it.
- **Set up the project** with [Development](docs/development.md#setup). The short version: Node 22.12+, Rust 1.93+, `npm install`, `./scripts/fetch-adb.sh`.

## Making a change

1. Create a branch from `main`.
2. Make the change, keeping to the [conventions](docs/development.md#conventions): style with design tokens, give every new bridge method a mock, and keep destructive actions behind a confirmation.
3. **Add tests** that fail without your change:
   - pure logic: a Vitest test next to the code;
   - behaviour you can see: a Playwright spec in `tests/e2e/`;
   - backend behaviour: a Rust test, using the in-process fake ADB server where possible.
4. Run everything that does not need a phone:

   ```bash
   npm run build
   npm run test:unit
   npm run test:e2e
   (cd src-tauri && cargo test)
   ```

5. **Update the documentation** in `docs/` if you changed what the app does. Quote the app's own wording for buttons and messages.
6. Open a pull request against `main`. Describe what changed and why, how you tested it, and, for anything that touches a real phone, which phone and Android version you used.

## Writing good commits and pull requests

- Use a short, imperative subject that says what changed ("Resume pushes from the partial file"), then a body explaining why when it is not obvious.
- Keep a pull request to one idea. Unrelated clean-ups belong in their own.
- Screenshots or a short recording help a lot for interface changes. Use the mock backend (`npm run dev`) so no real data appears.

## Reporting a bug

Please include:

- what you did, what you expected, and what happened (the exact message helps);
- the Mac's macOS version and architecture;
- the phone's model and Android version, and whether it was connected by cable or Wi-Fi;
- the output of `npm run tauri dev` around the failure, if you can reproduce it from source.

Do not paste real file names, photos or other private data. The demo data in the mock backend is enough to show most problems.

## Security

If you find a security problem, please do not open a public issue. Report it privately to the maintainers instead, so it can be fixed before it is described in public.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE), the same as the project.
