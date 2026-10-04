# Security

NoirWire holds people's money, and this server stands between every wallet and the network. If you find a way to take money, to make the relayer pay for something it should not, or to learn who owns what, please tell us privately before telling anyone else.

## Reporting a vulnerability

Email **ph1l1ph@proton.me**.

Include what you found, how to reproduce it, and what an attacker gains. A proof of concept helps. Please do not open a public issue, and do not test against wallets, funds or deployments that are not yours.

You will get an acknowledgement, and we will keep you informed while we work on a fix. We will credit you when the fix ships unless you would rather we did not.

## What matters most

- Anything that has the fee relayer sign a transaction outside the template, without the portfolio's signature, or for less than this server's price.
- Anything that sends a caller's IP address, token, or any other detail of their request to a provider, or writes one to a log.
- Anything that reaches a provider with a method or a path that is not on a route's list, or passes a provider's content on as something other than bounded JSON.
- Anything that links a portfolio's address to the funding wallet or to another portfolio.
- Anything that gets past the session check, or makes a `401` mean something other than "this session is not accepted".
- Anything that lifts a rate limit or a budget, beyond what the documentation already says about them.
