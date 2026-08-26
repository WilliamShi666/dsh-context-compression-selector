# Security policy

## Supported versions

During the initial release, only the newest published Beta or stable version is supported. Compatibility is limited to the Harness versions listed in the README.

## Reporting a vulnerability

Please use GitHub's private **Report a vulnerability** flow for this repository. Do not open a public issue containing secrets, exploit details, private Session data, prompts, tool results, or user paths.

Include the affected plugin version, Harness version, minimal reproduction, impact, and whether the issue can alter Session surface/recovery behavior. We will acknowledge a valid report as soon as practical, investigate privately, and publish a coordinated fix and advisory when appropriate.

## Security posture

- The Bundle does not require credentials of its own.
- Compression and recovery are same-Session operations; audit records omit model-visible content.
- Unknown models, tokenizer integrity failures, malformed policies, unsafe tool groups, and incomplete exact measurements fail open.
- NPM tarballs use explicit file allowlists and do not ship source maps, user logs, Sessions, or local configuration.
