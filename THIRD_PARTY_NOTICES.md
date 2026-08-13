# Third-party notices

Safire uses third-party software. Those components remain subject to their
respective licenses; the Safire proprietary notice does not replace, narrow,
or extend those licenses.

## Direct application components

| Component | Version in the current lockfile | License |
| --- | ---: | --- |
| [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | 1.29.0 | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.13 | MPL-2.0 OR Apache-2.0 |
| [Express](https://github.com/expressjs/express) | 5.2.1 | MIT |
| [Undici](https://github.com/nodejs/undici) | 8.10.0 | MIT |
| [Zod](https://github.com/colinhacks/zod) | 4.4.3 | MIT |
| [React](https://github.com/facebook/react) | 19.2.7 | MIT |
| [React DOM](https://github.com/facebook/react) | 19.2.7 | MIT |
| [Marked](https://github.com/markedjs/marked) | 18.0.5 | MIT |
| [Electron](https://github.com/electron/electron) | 43.0.0 | MIT, plus notices for bundled third-party software |

## Direct development and packaging components

| Component | Version in the current lockfile | License |
| --- | ---: | --- |
| [Vite](https://github.com/vitejs/vite) | 8.1.3 | MIT |
| [Vite React plugin](https://github.com/vitejs/vite-plugin-react) | 6.0.3 | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) | 6.0.3 | Apache-2.0 |
| [electron-builder](https://github.com/electron-userland/electron-builder) | 26.15.3 | MIT |
| [React type definitions](https://github.com/DefinitelyTyped/DefinitelyTyped) | 19.2.17 | MIT |
| [React DOM type definitions](https://github.com/DefinitelyTyped/DefinitelyTyped) | 19.2.3 | MIT |

Standard license texts are available from SPDX for
[MIT](https://spdx.org/licenses/MIT.html),
[Apache-2.0](https://spdx.org/licenses/Apache-2.0.html), and
[MPL-2.0](https://spdx.org/licenses/MPL-2.0.html). The corresponding package
distributions and upstream repositories contain their applicable copyright
notices and license files.

The lockfile also identifies transitive packages used to install, build, or
run Safire. Packaged software, including Electron and its Chromium and Node.js
components, may carry additional notices. Required license and attribution
materials supplied with those components must be preserved in distributions.

This document is a practical summary of direct dependencies, not an
exhaustive software bill of materials or legal opinion. Versions and dependency
trees can change. Review the lockfile, packaged artifacts, and upstream license
files when preparing any distribution.
