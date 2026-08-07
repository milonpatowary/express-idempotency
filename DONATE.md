# Support this project

`express-idempotency` is free, MIT-licensed, and maintained in spare time. There is no paid tier, no
"pro" version, and nothing behind a login.

If it saved you real time — or caught a duplicate charge before your customer did — a one-off
contribution is genuinely appreciated. It is never expected, and it buys no priority: bug reports,
questions and pull requests get the same attention from everyone.

## Ways to give

| | |
|---|---|
| **GitHub Sponsors** | https://github.com/sponsors/milonpatowary |
| **Ko-fi** (one-off, no account needed) | https://ko-fi.com/milonpatowary |

## Crypto

> [!WARNING]
> **Send only the named asset on the named network.** These are per-network addresses. Anything
> sent on a different network — USDT over TRON to the BNB Smart Chain address, for example — is
> almost certainly unrecoverable.

| Asset | Network | Address |
|---|---|---|
| TRX | TRON | `TLVs5cx85cwUCCGV8KujZkh5gDCpxomTd6` |
| USDT | BNB Smart Chain (BEP-20) | `0x737d85ECF68EAEF3dA5Ac912412D98e721F80ab9` |
| TON | The Open Network | `UQAKmKyA3_vfYwjwUPa3wiVjr5JIqEsKd_6YDpkT3yhI6g4_` |

The BNB Smart Chain address is an EVM-format address, which means it *looks* valid on Ethereum
mainnet, Polygon and every other EVM chain. It is not. Only BNB Smart Chain.

**Check the address before you send.** Compare it against the copy on
[the GitHub repository](https://github.com/milonpatowary/express-idempotency/blob/main/DONATE.md)
rather than a mirror, a fork, or a package-registry rendering — any of those can be stale or
altered. Verify the first and last six characters at minimum.

## A note on address tampering

Swapping a single character in a donation address via an innocuous-looking documentation pull
request is a known and recurring attack on open-source repositories. Two things guard against it here:

- `DONATE.md` is covered by [CODEOWNERS](./.github/CODEOWNERS), so a review is required before any
  change to it can merge.
- Any commit touching this file will say so plainly in its message. A change to an address that is
  not accompanied by an explicit note in the commit message should be treated as suspect and
  reported via [a security advisory](https://github.com/milonpatowary/express-idempotency/security/advisories/new).

If you maintain a fork, please point donation links at yourself or remove them — leaving them
pointing here while accepting the credit is the sort of thing that erodes trust in everyone's links.

## Other ways to help, which are worth more than money

- Report a bug with a reproduction. A reproducible bug report is worth several donations.
- Tell me what broke in production. Failure reports from real systems are how the awkward cases in
  the README got written.
- Improve the docs. If something took you two attempts to understand, that is a docs bug.
- Star the repo, or mention it where someone is about to write this middleware themselves.

## Commercial work

If you are building something where this class of problem matters — ledgers, payments, multi-tenant
platforms — I take on retained development and platform ownership contracts through Zexabit
Technology Ltd: [zexabit.com](https://zexabit.com) · support@zexabit.com

Thank you either way. — Milon
