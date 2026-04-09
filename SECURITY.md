# Security Policy

## Supported Versions

Security fixes are applied to the latest published version on the `main` branch.

| Version | Supported |
| ------- | --------- |
| Latest release | Yes |
| Older releases | No |
| Unreleased forks | No |

## Reporting a Vulnerability

Please report suspected vulnerabilities privately.

- Prefer GitHub Private Vulnerability Reporting for this repository.
- Do not open public GitHub issues for security reports.
- Include affected version, reproduction steps, impact, and any proposed mitigations.

If private reporting is unavailable, contact the maintainer through GitHub and request a private coordination channel before sharing details.

## Response Expectations

- Initial triage target: within 5 business days
- Status update target: within 10 business days when the issue is confirmed
- Fix timing depends on severity, exploitability, and release coordination needs

## Scope

This policy covers:

- The standalone `@abdullah4ai/openclaw-tenant-bridge` repository
- Published ClawHub and npm package artifacts for this repository
- The plugin bridge routes, storage integration, permission checks, and memory retrieval logic

Out of scope unless they are triggered by this repository:

- Vulnerabilities that exist only in upstream OpenClaw core
- Third-party services you deploy alongside the plugin
- Social engineering, phishing, spam, or denial-of-service without a product bug

## Disclosure

Please allow time for validation, remediation, and coordinated disclosure before publishing details.
