# Security Policy

## Reporting

This project does not maintain a private contact mailbox yet. If you have found a security-relevant
issue, report it privately via the repository's **Report a vulnerability** flow so it is not
published before it is understood.

## Expectations

- Untrusted-host boundaries (terminal, native browser) are owned by GPUIX; Heddlework fails closed
  (e.g. native CEF outside a validated app bundle).
- Papering over a reported issue with a silent-vulnerability workaround is against policy; fix it
  openly and reference the report.

## Supported versions

Only `main` and the most recent tagged release (if any) receive security fixes.
